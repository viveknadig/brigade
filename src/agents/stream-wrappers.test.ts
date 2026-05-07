import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BrigadeIdleTimeoutError,
  extractBalancedJsonPrefix,
  repairArgumentJson,
  wrapStreamFnWithIdleTimeout,
  wrapStreamFnWithStopReasonRecovery,
  wrapStreamFnWithToolCallRepair,
} from "./stream-wrappers.js";

// Build a fake EventStream — Pi's auth-aware streamFn returns a pi-ai
// EventStream which has BOTH `[Symbol.asyncIterator]` AND `result()`. The
// wrappers must preserve both surfaces; failing to expose `result()` was
// the production-failure root cause for the first version of these tests.
function fakeEventStream(events: unknown[], opts: { delayMs?: number; finalResult?: unknown } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        if (opts.delayMs && opts.delayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        yield ev;
      }
    },
    async result() {
      return opts.finalResult ?? { type: "done" };
    },
  };
}

test("wrappers preserve `.result()` (the production-bug regression test)", async () => {
  // The earlier wrapper turned this into an AsyncGenerator with no
  // .result() method, causing Pi to silently fail the turn.
  const final = { kind: "final-message", text: "hi" };
  const base = () => fakeEventStream([{ type: "delta" }], { finalResult: final });
  for (const wrap of [
    (f: () => unknown) => wrapStreamFnWithIdleTimeout(f, { timeoutMs: 1_000 }),
    (f: () => unknown) => wrapStreamFnWithStopReasonRecovery(f),
    (f: () => unknown) => wrapStreamFnWithToolCallRepair(f),
  ]) {
    const wrapped = wrap(base) as () => Promise<{
      result(): Promise<unknown>;
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
    }>;
    const stream = await wrapped();
    assert.equal(typeof stream.result, "function", "wrapped stream must expose result()");
    // Iterate first so we don't deadlock waiting for events.
    for await (const _ev of stream) {
      /* drain */
    }
    const r = await stream.result();
    assert.equal((r as { kind: string }).kind, "final-message");
  }
});

test("extractBalancedJsonPrefix: simple object", () => {
  assert.equal(extractBalancedJsonPrefix(`{"a":1}`), `{"a":1}`);
});

test("extractBalancedJsonPrefix: nested with trailing garbage", () => {
  assert.equal(extractBalancedJsonPrefix(`{"a":{"b":2}}trailing`), `{"a":{"b":2}}`);
});

test("extractBalancedJsonPrefix: array", () => {
  assert.equal(extractBalancedJsonPrefix(`[1,2,3]`), `[1,2,3]`);
});

test("extractBalancedJsonPrefix: unclosed returns null", () => {
  assert.equal(extractBalancedJsonPrefix(`{"a":1`), null);
});

test("extractBalancedJsonPrefix: handles strings with escaped quotes", () => {
  assert.equal(extractBalancedJsonPrefix(`{"a":"hi \\"there\\""}`), `{"a":"hi \\"there\\""}`);
});

test("extractBalancedJsonPrefix: handles braces inside strings", () => {
  assert.equal(extractBalancedJsonPrefix(`{"text":"this } isn't a real close"}`), `{"text":"this } isn't a real close"}`);
});

test("repairArgumentJson: clean JSON returns null (no repair needed)", () => {
  assert.equal(repairArgumentJson("not-json"), null);
});

test("repairArgumentJson: HTML-entity-decoded JSON", () => {
  const raw = `{&quot;name&quot;: &quot;hi&quot;}`;
  const repaired = repairArgumentJson(raw);
  assert.ok(repaired);
  assert.equal((JSON.parse(repaired!) as { name: string }).name, "hi");
});

test("repairArgumentJson: trailing garbage after balanced JSON", () => {
  const raw = `{"name":"hi"}\n\nsome trailing log line`;
  const repaired = repairArgumentJson(raw);
  assert.ok(repaired);
  assert.equal((JSON.parse(repaired!) as { name: string }).name, "hi");
});

test("repairArgumentJson: leading garbage before balanced JSON", () => {
  const raw = `args: {"name":"hi"}`;
  const repaired = repairArgumentJson(raw);
  assert.ok(repaired);
  assert.equal((JSON.parse(repaired!) as { name: string }).name, "hi");
});

test("repairArgumentJson: malformed beyond repair returns null", () => {
  assert.equal(repairArgumentJson(`{"name": broken everywhere`), null);
});

test("wrapStreamFnWithStopReasonRecovery: rewrites unhandled stop reason event as error", async () => {
  const base = () =>
    fakeEventStream([
      { type: "delta", text: "hi" },
      { type: "stop_reason", message: "Unhandled stop reason: foobar" },
    ]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string; message?: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string; message?: string }>) {
    events.push(ev);
  }
  assert.equal(events[0]!.type, "delta");
  assert.equal(events[1]!.type, "error");
  assert.match(events[1]!.message!, /unhandled stop reason: foobar/);
});

test("wrapStreamFnWithStopReasonRecovery: passes through unrelated events", async () => {
  const base = () => fakeEventStream([{ type: "delta", text: "x" }]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: unknown[] = [];
  for await (const ev of stream as AsyncIterable<unknown>) events.push(ev);
  assert.equal(events.length, 1);
});

test("wrapStreamFnWithStopReasonRecovery: pause_turn 'unhandled' is converted to a signal, not an error", async () => {
  const base = () =>
    fakeEventStream([{ type: "stop_reason", message: "Unhandled stop reason: pause_turn" }]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string }>) events.push(ev);
  assert.equal(events[0]!.type, "stop_reason_signal");
});

test("wrapStreamFnWithStopReasonRecovery: max_tokens stop_reason emits both original and signal", async () => {
  const base = () =>
    fakeEventStream([
      { type: "delta", text: "partial answer" },
      { type: "message_stop", stop_reason: "max_tokens" },
    ]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string }>) events.push(ev);
  assert.equal(events.length, 3);
  assert.equal(events[1]!.type, "message_stop");
  assert.equal(events[2]!.type, "stop_reason_signal");
});

test("wrapStreamFnWithStopReasonRecovery: end_turn passes through cleanly", async () => {
  const base = () => fakeEventStream([{ type: "message_stop", stop_reason: "end_turn" }]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string }>) events.push(ev);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "message_stop");
});

test("wrapStreamFnWithStopReasonRecovery: malformed_response stop_reason is rewritten as error", async () => {
  const base = () =>
    fakeEventStream([{ type: "message_stop", stop_reason: "malformed_response" }]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string; message?: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string; message?: string }>) {
    events.push(ev);
  }
  assert.equal(events[0]!.type, "error");
  assert.match(events[0]!.message!, /malformed_response/);
});

test("wrapStreamFnWithToolCallRepair: repairs malformed toolcall arguments", async () => {
  const base = () =>
    fakeEventStream([{ type: "toolcall", arguments: `{&quot;name&quot;:&quot;hi&quot;}` }]);
  const wrapped = wrapStreamFnWithToolCallRepair(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { type: string; arguments?: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string; arguments?: string }>) {
    events.push(ev);
  }
  assert.ok(events[0]?.arguments);
  const parsed = JSON.parse(events[0]!.arguments!);
  assert.equal(parsed.name, "hi");
});

test("wrapStreamFnWithToolCallRepair: passes through valid toolcall arguments unchanged", async () => {
  const base = () => fakeEventStream([{ type: "toolcall", arguments: `{"name":"hi"}` }]);
  const wrapped = wrapStreamFnWithToolCallRepair(base);
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const events: { arguments?: string }[] = [];
  for await (const ev of stream as AsyncIterable<{ arguments?: string }>) events.push(ev);
  assert.equal(events[0]!.arguments, `{"name":"hi"}`);
});

test("wrapStreamFnWithIdleTimeout: timer disabled when timeoutMs<=0 → returns base", async () => {
  const base = () => fakeEventStream([{ type: "delta" }]);
  const wrapped = wrapStreamFnWithIdleTimeout(base, { timeoutMs: 0 });
  // Reference identity check — wrapper short-circuited.
  assert.strictEqual(wrapped, base);
});

test("wrapStreamFnWithIdleTimeout: trips on a stalled stream", async () => {
  // A stream that produces one event then stalls forever.
  function stallingStream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "delta", text: "first" };
        await new Promise(() => {
          /* stall */
        });
      },
      async result() {
        return { type: "done" };
      },
    };
  }
  const wrapped = wrapStreamFnWithIdleTimeout(stallingStream, { timeoutMs: 50 });
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  let events = 0;
  let caughtTimeout = false;
  try {
    for await (const _ev of stream as AsyncIterable<unknown>) events++;
  } catch (err) {
    caughtTimeout =
      err instanceof BrigadeIdleTimeoutError ||
      (err as { name?: string }).name === "TimeoutError";
  }
  assert.equal(events, 1);
  assert.equal(caughtTimeout, true);
});

test("wrapStreamFnWithIdleTimeout: passes through if stream completes within budget", async () => {
  const base = () =>
    fakeEventStream([{ type: "a" }, { type: "b" }], { delayMs: 5 });
  const wrapped = wrapStreamFnWithIdleTimeout(base, { timeoutMs: 1_000 });
  const stream = await (wrapped() as unknown as Promise<{ [Symbol.asyncIterator](): AsyncIterator<unknown> }>);
  const seen: unknown[] = [];
  for await (const ev of stream as AsyncIterable<unknown>) seen.push(ev);
  assert.equal(seen.length, 2);
});
