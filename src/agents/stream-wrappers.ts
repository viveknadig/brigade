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
// This module ships three composable wrappers:
//
//   • wrapStreamFnWithIdleTimeout — bound the time we'll wait for a
//     streaming response without progress. A hung provider (TCP open, no
//     bytes coming) would otherwise tie up the run forever.
//
//   • wrapStreamFnWithStopReasonRecovery — when a provider returns an
//     "unhandled stop reason" (some proxies emit unexpected values), remap
//     to a clean `error` stop with a normalised message so downstream
//     classification + retry can see a real reason.
//
//   • wrapStreamFnWithToolCallRepair — best-effort cleanup of malformed
//     tool-call argument JSON (truncated, HTML-entity encoded, leading or
//     trailing garbage). Same pattern several proxy providers use.
//
// Pi's Agent.streamFn signature isn't exported as a public type, so we
// preserve it via `typeof session.agent.streamFn` at the call site. The
// wrappers here are typed against an opaque `BrigadeStreamFn` and expect
// the caller to thread Pi's actual function in/out.

export type BrigadeStreamFn = (...args: unknown[]) => unknown;

// ─────────────────────────────────────────────────────────────────────────────
// Idle-timeout wrapper.
//
// The base streamFn returns either:
//   • a Promise that resolves with `{ result, stream }` where `stream` is
//     an async iterable of events; or
//   • an async iterable directly.
//
// In either case we race a timer against the iterator's `next()`. If the
// timer wins, we signal cancel (via the abort signal we forward) and throw
// a TimeoutError that the classifier maps to `timeout`.
// ─────────────────────────────────────────────────────────────────────────────

export interface IdleTimeoutOptions {
  timeoutMs: number;
  // Optional observation hook fired when the timer trips.
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
  const wrapped = (async function* (this: unknown, ...args: unknown[]) {
    const result = await Promise.resolve(base.apply(this, args));
    const iterable = pickAsyncIterable(result);
    if (!iterable) {
      // Result wasn't an iterable; pass through. Most provider stream
      // functions return one, but the wrapper is conservative.
      yield result;
      return;
    }
    const startedAt = Date.now();
    const iterator = iterable[Symbol.asyncIterator]();

    while (true) {
      const next = iterator.next();
      const timer = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          options.onIdleTimeout?.(Date.now() - startedAt);
          reject(new BrigadeIdleTimeoutError(options.timeoutMs));
        }, options.timeoutMs);
        // Don't let an unfinished timer keep the process alive.
        if (typeof (t as { unref?: () => void }).unref === "function") {
          (t as { unref: () => void }).unref();
        }
        next.finally(() => clearTimeout(t));
      });
      const step = (await Promise.race([next, timer])) as IteratorResult<unknown>;
      if (step.done) return;
      yield step.value;
    }
  }) as unknown as F;
  return wrapped;
}

function pickAsyncIterable(value: unknown): AsyncIterable<unknown> | null {
  if (!value) return null;
  if (typeof value !== "object" && typeof value !== "function") return null;
  const iterable = (value as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
    Symbol.asyncIterator
  ];
  if (typeof iterable === "function") return value as AsyncIterable<unknown>;
  // Some streamFns return `{ result, stream: AsyncIterable }`; surface the
  // stream when present.
  const inner = (value as { stream?: unknown }).stream;
  if (inner && typeof inner === "object") {
    const innerIter = (inner as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
      Symbol.asyncIterator
    ];
    if (typeof innerIter === "function") return inner as AsyncIterable<unknown>;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-reason recovery.
//
// Stop reasons fall into three buckets:
//
//   1. NORMAL — the response completed cleanly. `end_turn`, `stop_sequence`,
//      `tool_use`. Pass through untouched.
//
//   2. PASS-THROUGH-WITH-METADATA — the response is incomplete in a way the
//      caller can act on without it being an error: `max_tokens`,
//      `pause_turn` (Anthropic extended thinking), `refusal` (model
//      explicitly refused; the refusal content IS the answer). For these
//      we emit the original `stop_reason` event AND a sibling
//      `{type:"stop_reason_signal"}` event so downstream code (the agent
//      loop's after-turn handler) can branch — auto-continue on
//      `max_tokens`, surface refusal text, etc.
//
//   3. ERROR — anything Pi flags as unhandled, plus the actual error stop
//      reasons (`error`, `malformed_response`). Rewrite to a clean
//      `{type:"error", message}` event so the classifier can map it to a
//      retry reason.
//
// `pause_turn` is the trickiest. The original Brigade wrapper rewrote ALL
// "unhandled stop reason: X" events as errors — which would convert a
// thinking-mode pause into a fake error. The new wrapper passes pause
// through and lets Pi handle the continuation.
// ─────────────────────────────────────────────────────────────────────────────

const UNHANDLED_STOP_REASON_RE = /^Unhandled stop reason:\s*(.+)$/i;

// Stop reasons we treat as benign — let them flow without rewriting.
const BENIGN_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "tool_use",
]);

// Stop reasons that need caller awareness but aren't errors. We tag the
// stream so the agent loop's after-turn handler can react.
const ACTIONABLE_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_tokens",
  "pause_turn",
  "refusal",
]);

// Stop reasons that ARE errors. Rewrite as error events.
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
  const wrapped = (async function* (this: unknown, ...args: unknown[]) {
    const result = await Promise.resolve(base.apply(this, args));
    const iterable = pickAsyncIterable(result);
    if (!iterable) {
      yield result;
      return;
    }
    for await (const ev of iterable) {
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
            yield ev; // preserve the original
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
          // Unknown enum value — pass through with an alert so the
          // caller can decide. We don't crash — Pi may be ahead of us
          // with a new stop reason from a provider update.
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
              // Pi flagged it as unhandled but we know how to handle it.
              // Drop the error rewrite and emit a signal instead.
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
  }) as unknown as F;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call argument repair.
//
// When a `toolcall_delta` event accumulates argument JSON, retry parsing on
// each delta. If the raw text fails JSON.parse but a balanced JSON prefix is
// extractable, repair it: HTML-entity decode, strip safe leading text, strip
// trailing garbage, and substitute the cleaned arguments on the event.
//
// Conservative — only repair when the original text fails to parse and a
// strict balanced extract succeeds. Any ambiguity = pass through unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export function wrapStreamFnWithToolCallRepair<F extends BrigadeStreamFn>(base: F): F {
  const wrapped = (async function* (this: unknown, ...args: unknown[]) {
    const result = await Promise.resolve(base.apply(this, args));
    const iterable = pickAsyncIterable(result);
    if (!iterable) {
      yield result;
      return;
    }
    for await (const ev of iterable) {
      yield maybeRepairToolCallEvent(ev);
    }
  }) as unknown as F;
  return wrapped;
}

function maybeRepairToolCallEvent(ev: unknown): unknown {
  if (!ev || typeof ev !== "object") return ev;
  const e = ev as { type?: unknown; arguments?: unknown; argumentsDelta?: unknown };
  if (e.type !== "toolcall" && e.type !== "toolcall_delta") return ev;
  const raw = typeof e.arguments === "string" ? e.arguments : undefined;
  if (!raw) return ev;
  // Quick path: already valid JSON.
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
  // Strip leading non-JSON garbage if it's short and "safe-ish".
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
