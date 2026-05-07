// Stream-fn wrappers for Pi's agent runtime.
//
// Pi exposes `Agent.streamFn` — the function that drives the actual provider
// HTTP call. `createAgentSession` from pi-coding-agent installs an
// auth-aware streamFn at session-creation time. We must NEVER REPLACE that
// function (a Brigade memory note locks this in: replacement loses the
// auth wrapping and every call goes silently keyless). What we CAN do is
// COMPOSE on top — wrap the auth-aware streamFn so the auth wrapper still
// sits at the bottom of the call stack.
//
// Critical shape constraint:
//
//   Pi's agent-loop calls `await streamFunction(model, ctx, opts)` and
//   then does BOTH `for await (const ev of response)` (event iteration)
//   AND `await response.result()` (final assistant message). The base
//   streamFn returns pi-ai's `EventStream`, which exposes both surfaces.
//
//   Earlier versions of these wrappers used `async function*` and
//   produced an `AsyncGenerator` instead — which is iterable but has no
//   `.result()` method. Pi's call to `response.result()` would silently
//   fail and the whole turn would settle with an empty `session.messages`,
//   producing no reply and no JSONL transcript. The fix below preserves
//   the EventStream shape by returning a proxy object that DELEGATES
//   `.result()` to the base stream and iterates via our own intercepted
//   iterator.
//
// This module ships three composable wrappers:
//
//   • wrapStreamFnWithIdleTimeout — bound the time we'll wait for a
//     streaming response without progress.
//
//   • wrapStreamFnWithStopReasonRecovery — re-bucket stop-reason events
//     into BENIGN / ACTIONABLE / ERROR per the taxonomy below.
//
//   • wrapStreamFnWithToolCallRepair — best-effort cleanup of malformed
//     tool-call argument JSON.

export type BrigadeStreamFn = (...args: unknown[]) => unknown;

// Pi's EventStream has at minimum these two surfaces. We don't import the
// type because the wrappers must work against any future Pi shape that
// preserves both — duck typing keeps us unwedged when Pi's internals
// evolve.
interface EventStreamLike {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  result(): Promise<unknown>;
}

function isEventStreamLike(value: unknown): value is EventStreamLike {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const v = value as { [Symbol.asyncIterator]?: unknown; result?: unknown };
  return typeof v[Symbol.asyncIterator] === "function" && typeof v.result === "function";
}

// Build a proxy that exposes the SAME surface as the inner stream
// (`[Symbol.asyncIterator]` + `result()` + any other own enumerable
// properties), but routes iteration through `iteratorFactory`. Used by
// every wrapper below — keeps the consumer-visible shape intact while
// letting us intercept events.
function makeStreamProxy<S extends EventStreamLike>(
  inner: S,
  iteratorFactory: (inner: S) => AsyncIterator<unknown>,
): EventStreamLike {
  return {
    [Symbol.asyncIterator]: () => iteratorFactory(inner),
    result: () => inner.result(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle-timeout wrapper.
//
// Race each `iterator.next()` call against a timer; if the timer wins, throw
// `BrigadeIdleTimeoutError` (whose `name` is "TimeoutError" so the
// classifier maps it to the timeout retry-policy bucket).
// ─────────────────────────────────────────────────────────────────────────────

export interface IdleTimeoutOptions {
  timeoutMs: number;
  onIdleTimeout?: (elapsedMs: number) => void;
}

export class BrigadeIdleTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`LLM idle timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function wrapStreamFnWithIdleTimeout<F extends BrigadeStreamFn>(
  base: F,
  options: IdleTimeoutOptions,
): F {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    // Timeout disabled — return base unchanged.
    return base;
  }
  const wrapped = (async function (this: unknown, ...args: unknown[]) {
    const stream = await Promise.resolve(base.apply(this, args));
    if (!isEventStreamLike(stream)) return stream;
    return makeStreamProxy(stream, (inner) => idleTimeoutIterator(inner, options));
  }) as unknown as F;
  return wrapped;
}

async function* idleTimeoutIterator(
  inner: EventStreamLike,
  options: IdleTimeoutOptions,
): AsyncGenerator<unknown> {
  const startedAt = Date.now();
  const iterator = inner[Symbol.asyncIterator]();
  while (true) {
    const next = iterator.next();
    const timer = new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        options.onIdleTimeout?.(Date.now() - startedAt);
        reject(new BrigadeIdleTimeoutError(options.timeoutMs));
      }, options.timeoutMs);
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
      next.finally(() => clearTimeout(t));
    });
    const step = (await Promise.race([next, timer])) as IteratorResult<unknown>;
    if (step.done) return;
    yield step.value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-reason recovery.
//
// Stop reasons fall into three buckets:
//
//   • NORMAL — `end_turn`, `stop_sequence`, `tool_use`. Pass through
//     untouched.
//
//   • ACTIONABLE — `max_tokens`, `pause_turn`, `refusal`. Emit the
//     original event AND a sibling `{type:"stop_reason_signal"}` event so
//     downstream code (the agent loop's after-turn handler) can branch.
//
//   • ERROR — `error`, `malformed_response`, `network_error`. Rewrite to a
//     clean `{type:"error", message}` event so the classifier can map it
//     to a retry reason.
//
// `pause_turn` is the trickiest — earlier wrappers rewrote ALL "unhandled
// stop reason" events as errors, which would convert thinking-mode pauses
// into fake errors. The new logic passes pause through.
// ─────────────────────────────────────────────────────────────────────────────

const UNHANDLED_STOP_REASON_RE = /^Unhandled stop reason:\s*(.+)$/i;

const BENIGN_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "tool_use",
]);

const ACTIONABLE_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_tokens",
  "pause_turn",
  "refusal",
]);

const ERROR_STOP_REASONS: ReadonlySet<string> = new Set([
  "error",
  "malformed_response",
  "network_error",
]);

export interface StopReasonSignal {
  type: "stop_reason_signal";
  reason: string;
  source: "pi" | "wrapper";
}

export function wrapStreamFnWithStopReasonRecovery<F extends BrigadeStreamFn>(base: F): F {
  const wrapped = (async function (this: unknown, ...args: unknown[]) {
    const stream = await Promise.resolve(base.apply(this, args));
    if (!isEventStreamLike(stream)) return stream;
    return makeStreamProxy(stream, (inner) => stopReasonIterator(inner));
  }) as unknown as F;
  return wrapped;
}

async function* stopReasonIterator(inner: EventStreamLike): AsyncGenerator<unknown> {
  for await (const ev of inner) {
    if (ev && typeof ev === "object") {
      const e = ev as { type?: unknown; message?: unknown; stop_reason?: unknown };

      // Path A: Pi already attached `stop_reason` to the event.
      if (typeof e.stop_reason === "string") {
        const reason = e.stop_reason.toLowerCase();
        if (BENIGN_STOP_REASONS.has(reason)) {
          yield ev;
          continue;
        }
        if (ACTIONABLE_STOP_REASONS.has(reason)) {
          yield ev;
          yield { type: "stop_reason_signal", reason, source: "pi" } as StopReasonSignal;
          continue;
        }
        if (ERROR_STOP_REASONS.has(reason)) {
          yield {
            ...e,
            type: "error",
            message: `provider returned ${reason} stop reason`,
          };
          continue;
        }
        // Unknown enum value — pass through with a signal.
        yield ev;
        yield { type: "stop_reason_signal", reason, source: "wrapper" } as StopReasonSignal;
        continue;
      }

      // Path B: Pi raised an "Unhandled stop reason: X" string error.
      if (typeof e.message === "string") {
        const m = UNHANDLED_STOP_REASON_RE.exec(e.message);
        if (m) {
          const reason = (m[1] ?? "unknown").toLowerCase();
          if (ACTIONABLE_STOP_REASONS.has(reason)) {
            yield { type: "stop_reason_signal", reason, source: "wrapper" } as StopReasonSignal;
            continue;
          }
          yield {
            ...e,
            type: "error",
            message: `provider returned unhandled stop reason: ${reason}`,
          };
          continue;
        }
      }
    }
    yield ev;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call argument repair.
//
// When a `toolcall_delta` event accumulates argument JSON that fails to
// parse, attempt repair: HTML-entity decode, balanced-JSON extraction,
// strip leading/trailing garbage. Only repair when the raw text fails
// JSON.parse AND a strict balanced extract succeeds.
// ─────────────────────────────────────────────────────────────────────────────

export function wrapStreamFnWithToolCallRepair<F extends BrigadeStreamFn>(base: F): F {
  const wrapped = (async function (this: unknown, ...args: unknown[]) {
    const stream = await Promise.resolve(base.apply(this, args));
    if (!isEventStreamLike(stream)) return stream;
    return makeStreamProxy(stream, (inner) => toolCallRepairIterator(inner));
  }) as unknown as F;
  return wrapped;
}

async function* toolCallRepairIterator(inner: EventStreamLike): AsyncGenerator<unknown> {
  for await (const ev of inner) {
    yield maybeRepairToolCallEvent(ev);
  }
}

function maybeRepairToolCallEvent(ev: unknown): unknown {
  if (!ev || typeof ev !== "object") return ev;
  const e = ev as { type?: unknown; arguments?: unknown };
  if (e.type !== "toolcall" && e.type !== "toolcall_delta") return ev;
  const raw = typeof e.arguments === "string" ? e.arguments : undefined;
  if (!raw) return ev;
  try {
    JSON.parse(raw);
    return ev;
  } catch {
    // continue to repair attempt
  }
  const repaired = repairArgumentJson(raw);
  if (!repaired) return ev;
  return { ...e, arguments: repaired };
}

const LEADING_GARBAGE_RE = /^[a-z0-9\s"'`.:/_\\-]{1,96}/i;

export function repairArgumentJson(raw: string): string | null {
  let candidate = raw;
  const leadingMatch = LEADING_GARBAGE_RE.exec(candidate);
  if (leadingMatch && !candidate.trimStart().startsWith("{") && !candidate.trimStart().startsWith("[")) {
    candidate = candidate.slice(leadingMatch[0].length);
  }

  const trimmed = candidate.trimStart();
  const open = trimmed[0];
  if (open !== "{" && open !== "[") return null;

  const balanced = extractBalancedJsonPrefix(trimmed);
  if (!balanced) return null;

  const decoded = decodeHtmlEntitiesShallow(balanced);
  try {
    JSON.parse(decoded);
    return decoded;
  } catch {
    return null;
  }
}

export function extractBalancedJsonPrefix(text: string): string | null {
  const open = text[0];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntitiesShallow(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITY_MAP[m] ?? m);
}
