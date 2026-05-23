/**
 * Tests for the SearXNG search provider — URL builder, base-URL validation
 * (SSRF posture: http:// must target private host; https:// allowed for
 * any host), env-var fallback.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildSearxngUrl,
	createSearxngSearchProvider,
	resolveSearxngBaseUrl,
	validateSearxngBaseUrl,
} from "./searxng.js";

describe("resolveSearxngBaseUrl", () => {
	it("returns undefined when nothing configured", () => {
		assert.equal(resolveSearxngBaseUrl({}, {} as never), undefined);
	});

	it("config beats env", () => {
		const r = resolveSearxngBaseUrl(
			{ baseUrl: "https://cfg.example" },
			{ SEARXNG_BASE_URL: "https://env.example" } as never,
		);
		assert.equal(r, "https://cfg.example");
	});

	it("falls back to env when config absent", () => {
		const r = resolveSearxngBaseUrl({}, { SEARXNG_BASE_URL: "https://env.example/" } as never);
		assert.equal(r, "https://env.example");
	});

	it("strips trailing slash", () => {
		const r = resolveSearxngBaseUrl({ baseUrl: "https://x/" }, {} as never);
		assert.equal(r, "https://x");
	});
});

describe("validateSearxngBaseUrl", () => {
	it("accepts https:// targeting public host", () => {
		assert.doesNotThrow(() => validateSearxngBaseUrl("https://search.example.com"));
	});

	it("accepts http:// targeting localhost", () => {
		assert.doesNotThrow(() => validateSearxngBaseUrl("http://localhost:8888"));
	});

	it("accepts http:// targeting RFC1918 private host", () => {
		assert.doesNotThrow(() => validateSearxngBaseUrl("http://10.0.0.5:8888"));
	});

	it("refuses http:// targeting a public host (would expose creds over plaintext)", () => {
		assert.throws(
			() => validateSearxngBaseUrl("http://search.example.com"),
			/private \/ loopback/i,
		);
	});

	it("refuses non-http(s) protocols", () => {
		assert.throws(() => validateSearxngBaseUrl("ftp://server/"), /must use http/i);
	});

	it("refuses malformed URLs", () => {
		assert.throws(() => validateSearxngBaseUrl("not a url"), /valid http/i);
	});
});

describe("buildSearxngUrl", () => {
	it("appends /search to base path", () => {
		const url = buildSearxngUrl({
			baseUrl: "https://search.example.com",
			query: "hello",
		});
		assert.ok(url.includes("/search?"));
		assert.ok(url.includes("q=hello"));
		assert.ok(url.includes("format=json"));
	});

	it("handles base URLs with trailing slash", () => {
		const url = buildSearxngUrl({
			baseUrl: "https://search.example.com/",
			query: "hi",
		});
		assert.ok(url.includes("/search?"));
	});

	it("attaches categories + language when provided", () => {
		const url = buildSearxngUrl({
			baseUrl: "https://search.example.com",
			query: "x",
			categories: "general",
			language: "en",
		});
		assert.ok(url.includes("categories=general"));
		assert.ok(url.includes("language=en"));
	});
});

describe("createSearxngSearchProvider", () => {
	const provider = createSearxngSearchProvider();

	it("declares identity + lowest priority (only picked as last resort)", () => {
		assert.equal(provider.id, "searxng");
		// SearXNG (180) loses to keyless DDG (100) — DDG is more reliable
		// out-of-box than a self-hosted instance that may not be running.
		assert.ok((provider.autoDetectOrder ?? 0) > 100);
	});

	it("isConfigured false when no baseUrl", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
	});

	it("isConfigured true with env baseUrl", () => {
		assert.equal(
			provider.isConfigured({} as never, { SEARXNG_BASE_URL: "http://localhost:8888" } as never),
			true,
		);
	});
});
