import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
	it("claim returns true for a fresh id, false for a repeat", () => {
		const cache = createDedupeCache();
		assert.equal(cache.claim("a"), true);
		assert.equal(cache.claim("a"), false);
		assert.equal(cache.claim("b"), true);
		assert.equal(cache.claim("b"), false);
	});

	it("an empty id is never deduped (let it through)", () => {
		const cache = createDedupeCache();
		assert.equal(cache.claim(""), true);
		assert.equal(cache.claim(""), true);
	});

	it("LRU-evicts oldest when maxEntries exceeded", () => {
		const cache = createDedupeCache({ maxEntries: 3 });
		cache.claim("a");
		cache.claim("b");
		cache.claim("c");
		cache.claim("d"); // evicts "a"
		assert.equal(cache.size, 3);
		assert.equal(cache.claim("a"), true, "evicted id should be treated as fresh");
	});

	it("expires entries past the TTL window", async () => {
		const cache = createDedupeCache({ ttlMs: 10 });
		cache.claim("x");
		assert.equal(cache.claim("x"), false);
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(cache.claim("x"), true, "expired id should be treated as fresh again");
	});

	it("clear() drops every entry", () => {
		const cache = createDedupeCache();
		cache.claim("a");
		cache.claim("b");
		cache.clear();
		assert.equal(cache.size, 0);
		assert.equal(cache.claim("a"), true);
	});

	/* ── remember() / peek() — the outbound-echo distinguishing API ── */

	it("remember(id) → peek(id) returns true", () => {
		const cache = createDedupeCache();
		assert.equal(cache.peek("outbound-1"), false, "unseen id peeks as false");
		cache.remember("outbound-1");
		assert.equal(cache.peek("outbound-1"), true);
	});

	it("peek does NOT mutate (idempotent reads)", () => {
		const cache = createDedupeCache({ maxEntries: 3 });
		cache.remember("a");
		// Peeking many times should not refresh LRU position OR claim the id.
		for (let i = 0; i < 10; i++) cache.peek("a");
		// Filling the cache to overflow should evict the oldest; "a" was
		// remembered first so it should be the one evicted by capacity.
		cache.remember("b");
		cache.remember("c");
		cache.remember("d"); // forces an eviction since maxEntries=3
		assert.equal(cache.size, 3);
		assert.equal(cache.peek("a"), false, "oldest entry should have been evicted");
	});

	it("peek returns false for empty id (defensive)", () => {
		const cache = createDedupeCache();
		assert.equal(cache.peek(""), false);
	});

	it("remember() with empty id is a no-op", () => {
		const cache = createDedupeCache();
		cache.remember("");
		assert.equal(cache.size, 0);
		assert.equal(cache.peek(""), false);
	});

	it("remember()-then-claim() returns false (echo of our own send is treated as already-seen)", () => {
		// This is the load-bearing semantic for outbound-echo dedupe: when
		// the WhatsApp socket mirrors back a message we just sent, that
		// inbound's id was already `remember()`'d. The manager calls
		// `peek()` first to special-case `fromMe`, but if `claim()` were
		// reached on a remembered id it must ALSO return false (already
		// seen) so the message can't double-fire.
		const cache = createDedupeCache();
		cache.remember("outbound-id");
		assert.equal(cache.claim("outbound-id"), false);
	});

	it("expired remember()s peek as false", async () => {
		const cache = createDedupeCache({ ttlMs: 10 });
		cache.remember("ephemeral");
		assert.equal(cache.peek("ephemeral"), true);
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(cache.peek("ephemeral"), false, "expired entry should peek false");
	});

	/* ── release() — 2-phase claim/release for retryable inbound failures ── */

	it("release(id) lets a subsequent claim() succeed (2-phase dedupe)", () => {
		const cache = createDedupeCache();
		assert.equal(cache.claim("msg-1"), true);
		assert.equal(cache.claim("msg-1"), false, "second claim deduped");
		cache.release("msg-1");
		assert.equal(cache.claim("msg-1"), true, "after release, re-claim should succeed");
	});

	it("release(id) is a no-op when the id was never claimed", () => {
		const cache = createDedupeCache();
		cache.release("never-seen");
		assert.equal(cache.size, 0);
	});

	it("release('') is silently ignored (defensive)", () => {
		const cache = createDedupeCache();
		cache.claim("real");
		cache.release("");
		assert.equal(cache.peek("real"), true, "real entries are untouched by empty-id release");
	});
});
