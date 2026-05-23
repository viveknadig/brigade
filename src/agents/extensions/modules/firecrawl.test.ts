/**
 * Tests for the Firecrawl provider — covers API-key resolution and the
 * header-injection defense (CR/LF/control chars stripped before the key
 * lands in a `Bearer` Authorization header).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createFirecrawlFetchProvider,
	createFirecrawlSearchProvider,
	readFirecrawlFetchConfig,
	readFirecrawlSearchConfig,
	resolveFirecrawlApiKey,
} from "./firecrawl.js";

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

describe("readFirecrawlFetchConfig", () => {
	it("returns empty object when no config slot", () => {
		assert.deepEqual(readFirecrawlFetchConfig({} as never), {});
	});

	it("reads proxy / storeInCache / maxAgeMs / timeoutSeconds / onlyMainContent", () => {
		const cfg = {
			tools: {
				web: {
					fetch: {
						providers: {
							firecrawl: {
								proxy: "stealth",
								storeInCache: false,
								maxAgeMs: 60_000,
								timeoutSeconds: 45,
								onlyMainContent: false,
							},
						},
					},
				},
			},
		};
		const r = readFirecrawlFetchConfig(cfg as never);
		assert.equal(r.proxy, "stealth");
		assert.equal(r.storeInCache, false);
		assert.equal(r.maxAgeMs, 60_000);
		assert.equal(r.timeoutSeconds, 45);
		assert.equal(r.onlyMainContent, false);
	});
});

describe("readFirecrawlSearchConfig", () => {
	it("reads sources/categories/scrapeResults", () => {
		const cfg = {
			tools: {
				web: {
					search: {
						providers: {
							firecrawl: {
								sources: ["web", "news"],
								categories: ["technology"],
								scrapeResults: true,
							},
						},
					},
				},
			},
		};
		const r = readFirecrawlSearchConfig(cfg as never);
		assert.deepEqual(r.sources, ["web", "news"]);
		assert.deepEqual(r.categories, ["technology"]);
		assert.equal(r.scrapeResults, true);
	});

	it("returns empty when no config slot", () => {
		assert.deepEqual(readFirecrawlSearchConfig({} as never), {});
	});
});

describe("createFirecrawlFetchProvider — provider shape", () => {
	const provider = createFirecrawlFetchProvider();

	it("declares the expected identity", () => {
		assert.equal(provider.id, "firecrawl");
		assert.equal(provider.label, "Firecrawl");
		assert.equal(provider.requiresCredential, true);
		assert.deepEqual(provider.envVars, ["FIRECRAWL_API_KEY"]);
	});

	it("isConfigured returns false without a key", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
	});

	it("isConfigured returns true with env key", () => {
		assert.equal(
			provider.isConfigured({} as never, { FIRECRAWL_API_KEY: "fc-x" } as never),
			true,
		);
	});

	it("createTool returns null without key, definition with key", () => {
		const ctxNoKey = { config: {} as never, env: {} as never, workspaceDir: "/tmp" };
		assert.equal(provider.createTool(ctxNoKey), null);
		const ctxKey = {
			config: {} as never,
			env: { FIRECRAWL_API_KEY: "fc-x" } as never,
			workspaceDir: "/tmp",
		};
		const def = provider.createTool(ctxKey);
		assert.ok(def);
		assert.ok(typeof def?.execute === "function");
	});
});

describe("createFirecrawlSearchProvider — provider shape", () => {
	const provider = createFirecrawlSearchProvider();

	it("declares the expected identity + autoDetectOrder priority", () => {
		assert.equal(provider.id, "firecrawl");
		assert.equal(provider.label, "Firecrawl Search");
		assert.equal(provider.requiresCredential, true);
		// Keyed providers MUST sort ahead of DuckDuckGo (200) so the operator's
		// paid backend is picked when configured.
		assert.ok((provider.autoDetectOrder ?? 999) < 200);
	});

	it("isConfigured false without key, true with env key", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
		assert.equal(
			provider.isConfigured({} as never, { FIRECRAWL_API_KEY: "fc-x" } as never),
			true,
		);
	});
});
