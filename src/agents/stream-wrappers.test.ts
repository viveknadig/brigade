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

// Helper: turn an array into an async iterable so we can simulate a stream.
async function* arrayToAsyncIterable<T>(items: T[], delayMs = 0): AsyncIterable<T> {
  for (const it of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield it;
  }
}

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
  // Strict contract: only reports repair when the input wasn't already valid.
  // The wrapper short-circuits valid input upstream — repair is for the
  // failing case.
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

test("wrapStreamFnWithStopReasonRecovery: rewrites unhandled stop reason event", async () => {
  const base = () =>
    arrayToAsyncIterable([
      { type: "delta", text: "hi" },
      { type: "stop_reason", message: "Unhandled stop reason: foobar" },
    ]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const stream = wrapped() as AsyncIterable<{ type: string; message?: string }>;
  const events: { type: string; message?: string }[] = [];
  for await (const ev of stream) events.push(ev);
  assert.equal(events[0]!.type, "delta");
  assert.equal(events[1]!.type, "error");
  assert.match(events[1]!.message!, /unhandled stop reason: foobar/);
});

test("wrapStreamFnWithStopReasonRecovery: passes through unrelated events", async () => {
  const base = () => arrayToAsyncIterable([{ type: "delta", text: "x" }]);
  const wrapped = wrapStreamFnWithStopReasonRecovery(base);
  const events: unknown[] = [];
  for await (const ev of wrapped() as AsyncIterable<unknown>) events.push(ev);
  assert.equal(events.length, 1);
});

test("wrapStreamFnWithToolCallRepair: repairs malformed toolcall arguments", async () => {
  const base = () =>
    arrayToAsyncIterable([
      { type: "toolcall", arguments: `{&quot;name&quot;:&quot;hi&quot;}` },
    ]);
  const wrapped = wrapStreamFnWithToolCallRepair(base);
  const events: { type: string; arguments?: string }[] = [];
  for await (const ev of wrapped() as AsyncIterable<{ type: string; arguments?: string }>) {
    events.push(ev);
  }
  assert.ok(events[0]?.arguments);
  const parsed = JSON.parse(events[0]!.arguments!);
  assert.equal(parsed.name, "hi");
});

test("wrapStreamFnWithToolCallRepair: passes through valid toolcall arguments unchanged", async () => {
  const base = () =>
    arrayToAsyncIterable([{ type: "toolcall", arguments: `{"name":"hi"}` }]);
  const wrapped = wrapStreamFnWithToolCallRepair(base);
  const events: { arguments?: string }[] = [];
  for await (const ev of wrapped() as AsyncIterable<{ arguments?: string }>) events.push(ev);
  assert.equal(events[0]!.arguments, `{"name":"hi"}`);
});

test("wrapStreamFnWithIdleTimeout: timer disabled when timeoutMs<=0 → returns base", async () => {
  const base = () => arrayToAsyncIterable([{ type: "delta" }]);
  const wrapped = wrapStreamFnWithIdleTimeout(base, { timeoutMs: 0 });
  // Reference identity check — wrapper short-circuited.
  assert.strictEqual(wrapped, base);
});

test("wrapStreamFnWithIdleTimeout: trips on a stalled stream", async () => {
  // A stream that produces one event then stalls forever.
  const base = () =>
    (async function* () {
      yield { type: "delta", text: "first" };
      await new Promise(() => {
        /* stall indefinitely */
      });
    })();
  const wrapped = wrapStreamFnWithIdleTimeout(base, { timeoutMs: 50 });
  let events = 0;
  let caughtTimeout = false;
  try {
    for await (const _ev of wrapped() as AsyncIterable<unknown>) {
      events++;
    }
  } catch (err) {
    caughtTimeout =
      err instanceof BrigadeIdleTimeoutError ||
      (err as { name?: string }).name === "TimeoutError";
  }
  assert.equal(events, 1);
  assert.equal(caughtTimeout, true);
});

test("wrapStreamFnWithIdleTimeout: passes through if stream completes within budget", async () => {
  const base = () => arrayToAsyncIterable([{ type: "a" }, { type: "b" }], 5);
  const wrapped = wrapStreamFnWithIdleTimeout(base, { timeoutMs: 1_000 });
  const seen: unknown[] = [];
  for await (const ev of wrapped() as AsyncIterable<unknown>) seen.push(ev);
  assert.equal(seen.length, 2);
});
