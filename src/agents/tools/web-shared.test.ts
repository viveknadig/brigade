/**
 * Tests for the shared web-tool primitives — cache, key normalization,
 * streamed body reader, and clamping helpers. Pure-logic; no network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildFetchCacheKey,
	buildSearchCacheKey,
	clampMaxBytes,
	type CacheEntry,
	DEFAULT_CACHE_MAX_ENTRIES,
	DEFAULT_CACHE_TTL_MINUTES,
	DEFAULT_MAX_RESPONSE_BYTES,
	MAX_RESPONSE_BYTES_CEILING,
	MAX_RESPONSE_BYTES_FLOOR,
	normalizeCacheKey,
	readCache,
	readResponseText,
	redactUrlForDebugLog,
	resolveCacheTtlMs,
	truncateText,
	writeCache,
} from "./web-shared.js";

describe("normalizeCacheKey", () => {
	it("lowercases + trims", () => {
		assert.equal(normalizeCacheKey("  Hello   "), "hello");
		assert.equal(normalizeCacheKey("Mixed:CASE:Key"), "mixed:case:key");
	});
});

describe("cache get/set + TTL + FIFO eviction", () => {
	it("write then read within TTL hits", () => {
		const cache = new Map<string, CacheEntry<string>>();
		writeCache(cache, "key1", "v1", { ttlMs: 60_000 });
		assert.equal(readCache(cache, "key1"), "v1");
	});

	it("expired entry returns undefined + deletes", async () => {
		const cache = new Map<string, CacheEntry<string>>();
		writeCache(cache, "key1", "v1", { ttlMs: 1 });
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(readCache(cache, "key1"), undefined);
		assert.equal(cache.has("key1"), false);
	});

	it("ttlMs<=0 disables writes", () => {
		const cache = new Map<string, CacheEntry<string>>();
		writeCache(cache, "key1", "v1", { ttlMs: 0 });
		assert.equal(readCache(cache, "key1"), undefined);
	});

	it("FIFO evicts oldest when exceeding maxEntries", () => {
		const cache = new Map<string, CacheEntry<string>>();
		writeCache(cache, "a", "1", { ttlMs: 60_000, maxEntries: 3 });
		writeCache(cache, "b", "2", { ttlMs: 60_000, maxEntries: 3 });
		writeCache(cache, "c", "3", { ttlMs: 60_000, maxEntries: 3 });
		writeCache(cache, "d", "4", { ttlMs: 60_000, maxEntries: 3 });
		// `a` was inserted first → evicted.
		assert.equal(cache.size, 3);
		assert.equal(readCache(cache, "a"), undefined);
		assert.equal(readCache(cache, "d"), "4");
	});

	it("matches casing differences (a:b vs A:B hit the same entry)", () => {
		const cache = new Map<string, CacheEntry<string>>();
		writeCache(cache, "Foo:Bar", "v1", { ttlMs: 60_000 });
		assert.equal(readCache(cache, "foo:bar"), "v1");
	});
});

describe("resolveCacheTtlMs + clampMaxBytes", () => {
	it("resolveCacheTtlMs defaults on garbage", () => {
		assert.equal(resolveCacheTtlMs(undefined), DEFAULT_CACHE_TTL_MINUTES * 60_000);
		assert.equal(resolveCacheTtlMs(Number.NaN), DEFAULT_CACHE_TTL_MINUTES * 60_000);
		assert.equal(resolveCacheTtlMs(-5), DEFAULT_CACHE_TTL_MINUTES * 60_000);
	});

	it("resolveCacheTtlMs accepts valid minutes", () => {
		assert.equal(resolveCacheTtlMs(5), 5 * 60_000);
		assert.equal(resolveCacheTtlMs(0), 0); // honored — 0 disables write
	});

	it("clampMaxBytes enforces [floor, ceiling]", () => {
		assert.equal(clampMaxBytes(undefined), DEFAULT_MAX_RESPONSE_BYTES);
		assert.equal(clampMaxBytes(1_000), MAX_RESPONSE_BYTES_FLOOR);
		assert.equal(clampMaxBytes(50_000_000), MAX_RESPONSE_BYTES_CEILING);
		assert.equal(clampMaxBytes(500_000), 500_000);
	});

	it("default cache max is 100", () => {
		assert.equal(DEFAULT_CACHE_MAX_ENTRIES, 100);
	});
});

describe("readResponseText — streamed cap + truncation", () => {
	it("returns empty result for null body", async () => {
		const r = await readResponseText(null, 1024);
		assert.equal(r.text, "");
		assert.equal(r.bytesRead, 0);
		assert.equal(r.truncated, false);
	});

	it("reads small body to completion", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("hello world"));
				controller.close();
			},
		});
		const r = await readResponseText(body, 1024);
		assert.equal(r.text, "hello world");
		assert.equal(r.bytesRead, 11);
		assert.equal(r.truncated, false);
	});

	it("truncates + sets `truncated: true` when body exceeds cap", async () => {
		// 2 KB stream, cap 100 bytes
		const big = "x".repeat(2048);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big));
				controller.close();
			},
		});
		const r = await readResponseText(body, 100);
		assert.equal(r.truncated, true);
		assert.ok(r.text.length <= 100);
	});
});

describe("buildSearchCacheKey + buildFetchCacheKey", () => {
	it("search key includes provider, query, count + lowercased", () => {
		const k = buildSearchCacheKey(["duckduckgo", "Hello World", 10]);
		assert.equal(k, "duckduckgo:hello world:10");
	});

	it("search key collapses undefined to `default`", () => {
		const k = buildSearchCacheKey(["brave", "x", undefined, null]);
		assert.equal(k, "brave:x:default:default");
	});

	it("fetch key composes url+mode+maxChars", () => {
		const k = buildFetchCacheKey({ url: "https://Example.com", extractMode: "markdown", maxChars: 5000 });
		assert.equal(k, "fetch:https://example.com:markdown:5000");
	});
});

describe("truncateText", () => {
	it("no-op when within budget", () => {
		const r = truncateText("hello", 10);
		assert.equal(r.text, "hello");
		assert.equal(r.truncated, false);
	});

	it("truncates with marker when over budget", () => {
		const r = truncateText("a".repeat(20), 10);
		assert.equal(r.truncated, true);
		assert.ok(r.text.startsWith("a".repeat(10)));
		assert.ok(r.text.includes("[truncated"));
	});

	it("handles bad maxChars (0/negative)", () => {
		const r = truncateText("hello", 0);
		assert.equal(r.text, "hello");
		assert.equal(r.truncated, false);
	});
});

describe("redactUrlForDebugLog", () => {
	it("hides path + query + fragment", () => {
		assert.equal(redactUrlForDebugLog("https://example.com/path/to?key=secret#frag"), "https://example.com/...");
	});

	it("handles malformed input gracefully", () => {
		assert.equal(redactUrlForDebugLog("not a url"), "(invalid url)");
	});
});
