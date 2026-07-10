import assert from "node:assert/strict";
import { test } from "node:test";

import {
	__resetTransportDispatchCache,
	__setBrigadeTransportForTests,
	installTransportDispatch,
	makeTransportDispatch,
	resolveBrigadeTransport,
} from "./transport-dispatch.js";

test("resolveBrigadeTransport: owns claude-cli + ollama, defers everything else", () => {
	__resetTransportDispatchCache();
	assert.equal(typeof resolveBrigadeTransport("claude-cli"), "function");
	assert.equal(typeof resolveBrigadeTransport("ollama"), "function");
	// Cloud APIs must fall through to Pi (which carries the auth wrapper).
	assert.equal(resolveBrigadeTransport("anthropic"), undefined);
	assert.equal(resolveBrigadeTransport("openai"), undefined);
	assert.equal(resolveBrigadeTransport("google"), undefined);
	assert.equal(resolveBrigadeTransport(undefined), undefined);
	assert.equal(resolveBrigadeTransport(""), undefined);
});

test("resolveBrigadeTransport: memoized (same instance per api)", () => {
	__resetTransportDispatchCache();
	assert.equal(resolveBrigadeTransport("claude-cli"), resolveBrigadeTransport("claude-cli"));
	assert.equal(resolveBrigadeTransport("ollama"), resolveBrigadeTransport("ollama"));
	assert.notEqual(resolveBrigadeTransport("claude-cli"), resolveBrigadeTransport("ollama"));
});

test("makeTransportDispatch: a cloud model still reaches Pi's base streamFn (auth preserved)", () => {
	const calls: string[] = [];
	const base = ((model: { api?: string }) => {
		calls.push(`base:${model.api}`);
		return "from-base";
	}) as never;
	const dispatch = makeTransportDispatch(base);
	assert.equal((dispatch as any)({ api: "anthropic" }, {}, {}), "from-base");
	assert.deepEqual(calls, ["base:anthropic"]);
});

test("makeTransportDispatch: a claude-cli model NEVER reaches Pi's base (no registry lookup)", () => {
	const calls: string[] = [];
	const base = (() => {
		calls.push("base");
		throw new Error("No API provider registered for api: claude-cli");
	}) as never;
	// Seed a FAKE transport. Invoking the REAL one spawns the `claude` binary and
	// writes to its stdin; a test that abandons that child leaves the pipe to die
	// after the test ends, which Node raises as an uncaught `write EPIPE`. That passed
	// on a developer machine and failed the npm publish job in CI.
	const seen: unknown[] = [];
	const fake = ((...args: unknown[]) => {
		seen.push(...args);
		return "from-brigade-transport";
	}) as never;
	__resetTransportDispatchCache();
	__setBrigadeTransportForTests("claude-cli", fake);

	try {
		const dispatch = makeTransportDispatch(base);
		const model = { api: "claude-cli", id: "claude-opus-4-8" };
		const ctx = { messages: [] };
		assert.equal((dispatch as any)(model, ctx, undefined), "from-brigade-transport");
		assert.deepEqual(calls, [], "base streamFn must not be consulted for claude-cli");
		assert.deepEqual(seen, [model, ctx, undefined], "args reach the transport positionally");
	} finally {
		__resetTransportDispatchCache();
	}
});

test("makeTransportDispatch: forwards all args positionally", () => {
	const seen: unknown[] = [];
	const base = ((...args: unknown[]) => {
		seen.push(...args);
		return "ok";
	}) as never;
	const dispatch = makeTransportDispatch(base);
	const model = { api: "openai" };
	const ctx = { messages: [] };
	const opts = { signal: undefined };
	(dispatch as any)(model, ctx, opts);
	assert.deepEqual(seen, [model, ctx, opts]);
});

test("installTransportDispatch: wraps (never replaces) an existing session streamFn", () => {
	const calls: string[] = [];
	const original = ((model: { api?: string }) => {
		calls.push(`orig:${model.api}`);
		return "orig";
	}) as never;
	const session = { agent: { streamFn: original } };
	installTransportDispatch(session);
	assert.notEqual(session.agent.streamFn, original, "wrapped");
	// cloud still reaches the original (auth wrapper preserved beneath)
	assert.equal((session.agent.streamFn as any)({ api: "anthropic" }, {}, {}), "orig");
	assert.deepEqual(calls, ["orig:anthropic"]);
});

test("installTransportDispatch: no-op on a session without an agent streamFn", () => {
	assert.doesNotThrow(() => installTransportDispatch(undefined));
	assert.doesNotThrow(() => installTransportDispatch({}));
	assert.doesNotThrow(() => installTransportDispatch({ agent: {} }));
});
