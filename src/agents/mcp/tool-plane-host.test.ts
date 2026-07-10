import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createMcpTurnRegistry,
	getActiveMcpToolPlaneHost,
	setActiveMcpToolPlaneHost,
	type McpTurnContext,
} from "./tool-plane-host.js";

const fakeCtx = (agentId = "main"): McpTurnContext => ({
	customTools: [],
	guard: async () => undefined,
	agentId,
});

test("register mints a 256-bit hex token and lookup resolves it", () => {
	const reg = createMcpTurnRegistry();
	const { token } = reg.register(fakeCtx());
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(reg.lookup(token)?.agentId, "main");
	assert.equal(reg.size(), 1);
});

test("dispose is idempotent and removes the entry", () => {
	const reg = createMcpTurnRegistry();
	const r = reg.register(fakeCtx());
	r.dispose();
	assert.equal(reg.lookup(r.token), undefined);
	assert.equal(reg.size(), 0);
	assert.doesNotThrow(() => r.dispose()); // idempotent
});

test("each registration is a distinct unguessable token", () => {
	const reg = createMcpTurnRegistry();
	const a = reg.register(fakeCtx("a"));
	const b = reg.register(fakeCtx("b"));
	assert.notEqual(a.token, b.token);
	assert.equal(reg.lookup(a.token)?.agentId, "a");
	assert.equal(reg.lookup(b.token)?.agentId, "b");
});

test("lookup rejects malformed tokens before hitting the map", () => {
	const reg = createMcpTurnRegistry();
	assert.equal(reg.lookup(""), undefined);
	assert.equal(reg.lookup("../evil"), undefined);
	assert.equal(reg.lookup("SHORT"), undefined);
	assert.equal(reg.lookup("g".repeat(64)), undefined); // non-hex
	assert.equal(reg.lookup(undefined as never), undefined);
});

test("host singleton: null by default (cold path), set/clear round-trips", () => {
	setActiveMcpToolPlaneHost(null);
	assert.equal(getActiveMcpToolPlaneHost(), null);
	const host = { baseUrl: "http://127.0.0.1:7777", registry: createMcpTurnRegistry() };
	setActiveMcpToolPlaneHost(host);
	assert.equal(getActiveMcpToolPlaneHost()?.baseUrl, "http://127.0.0.1:7777");
	setActiveMcpToolPlaneHost(null);
	assert.equal(getActiveMcpToolPlaneHost(), null);
});

/* ─────────────────────── bounds: TTL + hard cap ─────────────────────── */

test("lookup: an entry older than the TTL is evicted, not served", () => {
	let t = 1_000;
	const reg = createMcpTurnRegistry({ ttlMs: 100, now: () => t });
	const { token } = reg.register(fakeCtx());
	assert.ok(reg.lookup(token), "live before expiry");
	t += 101;
	assert.equal(reg.lookup(token), undefined, "expired token must not resolve");
	assert.equal(reg.size(), 0, "and is dropped from the map");
});

test("register: prunes expired entries and never grows past the cap", () => {
	let t = 0;
	const reg = createMcpTurnRegistry({ maxEntries: 3, ttlMs: 10_000, now: () => t });
	const tokens = [reg.register(fakeCtx("a")).token, reg.register(fakeCtx("b")).token, reg.register(fakeCtx("c")).token];
	assert.equal(reg.size(), 3);
	// A 4th registration must evict the OLDEST rather than grow unbounded.
	const fourth = reg.register(fakeCtx("d")).token;
	assert.equal(reg.size(), 3, "cap holds");
	assert.equal(reg.lookup(tokens[0] as string), undefined, "oldest evicted");
	assert.ok(reg.lookup(fourth), "newest present");
});

test("register: TTL pruning reclaims leaked entries (a turn that never disposed)", () => {
	let t = 0;
	const reg = createMcpTurnRegistry({ maxEntries: 100, ttlMs: 500, now: () => t });
	reg.register(fakeCtx("leaked")); // never disposed
	assert.equal(reg.size(), 1);
	t += 501;
	reg.register(fakeCtx("fresh")); // registration prunes first
	assert.equal(reg.size(), 1, "leaked entry reclaimed");
});

test("a live turn's token survives well past a normal turn length", () => {
	let t = 0;
	const reg = createMcpTurnRegistry({ now: () => t }); // production defaults
	const { token } = reg.register(fakeCtx());
	t += 30 * 60 * 1000; // the tool-plane hard ceiling
	assert.ok(reg.lookup(token), "TTL must never evict a still-running turn");
});
