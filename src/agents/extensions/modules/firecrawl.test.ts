/**
 * Tests for the Firecrawl provider — covers API-key resolution and the
 * header-injection defense (CR/LF/control chars stripped before the key
 * lands in a `Bearer` Authorization header).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveFirecrawlApiKey } from "./firecrawl.js";

describe("resolveFirecrawlApiKey", () => {
	it("returns the env key when set", () => {
		const r = resolveFirecrawlApiKey({} as never, { FIRECRAWL_API_KEY: "fc-test123" } as never);
		assert.equal(r, "fc-test123");
	});

	it("prefers the config key over env", () => {
		const cfg = { tools: { web: { fetch: { providers: { firecrawl: { apiKey: "fc-from-cfg" } } } } } };
		const r = resolveFirecrawlApiKey(cfg as never, { FIRECRAWL_API_KEY: "fc-from-env" } as never);
		assert.equal(r, "fc-from-cfg");
	});

	it("returns undefined when neither is set", () => {
		const r = resolveFirecrawlApiKey({} as never, {} as never);
		assert.equal(r, undefined);
	});

	it("strips CR/LF from a poisoned env key (header-injection defense)", () => {
		// A key with embedded CR/LF would let an attacker forge a second
		// header (`Authorization: Bearer fc\r\nX-Forwarded-For: 1.2.3.4`).
		// The sanitizer must drop those before the key is concatenated.
		const r = resolveFirecrawlApiKey(
			{} as never,
			{ FIRECRAWL_API_KEY: "fc-good\r\nX-Smuggled: evil" } as never,
		);
		assert.equal(r, "fc-goodX-Smuggled: evil");
		assert.ok(!r?.includes("\r"));
		assert.ok(!r?.includes("\n"));
	});

	it("strips NUL + tab from key", () => {
		const r = resolveFirecrawlApiKey(
			{} as never,
			{ FIRECRAWL_API_KEY: "fc-a\0b\tc" } as never,
		);
		assert.equal(r, "fc-abc");
	});

	it("strips non-ASCII bytes from key", () => {
		const r = resolveFirecrawlApiKey(
			{} as never,
			{ FIRECRAWL_API_KEY: "fc-testÿ" } as never,
		);
		assert.equal(r, "fc-test");
	});

	it("returns undefined when sanitization leaves empty string", () => {
		const r = resolveFirecrawlApiKey({} as never, { FIRECRAWL_API_KEY: "\r\n\0" } as never);
		assert.equal(r, undefined);
	});
});
