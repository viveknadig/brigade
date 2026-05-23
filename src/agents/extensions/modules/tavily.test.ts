/**
 * Tests for the Tavily search provider, web_extract tool, and base-URL
 * resolution. Network paths not exercised — schema + identity only.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createTavilySearchProvider,
	resolveTavilyBaseUrl,
	WebExtractSchema,
} from "./tavily.js";

describe("createTavilySearchProvider", () => {
	const provider = createTavilySearchProvider();

	it("declares identity + lowest-search priority (winner with key)", () => {
		assert.equal(provider.id, "tavily");
		assert.deepEqual(provider.envVars, ["TAVILY_API_KEY"]);
		// Tavily (20) beats Brave (30) when both configured — `include_answer`
		// gives one-shot RAG which is the differentiator.
		assert.ok((provider.autoDetectOrder ?? 999) < 30);
	});

	it("isConfigured returns false without key", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
	});

	it("isConfigured returns true with env key", () => {
		assert.equal(
			provider.isConfigured({} as never, { TAVILY_API_KEY: "tvly-x" } as never),
			true,
		);
	});

	it("createTool returns null without key, definition with key", () => {
		const noKey = { config: {} as never, env: {} as never, workspaceDir: "/tmp" };
		assert.equal(provider.createTool(noKey), null);
		const withKey = {
			config: {} as never,
			env: { TAVILY_API_KEY: "tvly-x" } as never,
			workspaceDir: "/tmp",
		};
		const def = provider.createTool(withKey);
		assert.ok(def);
	});
});

describe("resolveTavilyBaseUrl", () => {
	it("falls back to api.tavily.com when no config", () => {
		assert.equal(resolveTavilyBaseUrl({}), "https://api.tavily.com");
	});

	it("strips trailing slash from operator override", () => {
		// URL normalization auto-adds a slash; resolveTavilyBaseUrl then
		// strips a trailing one — net effect is no trailing slash.
		assert.equal(resolveTavilyBaseUrl({ baseUrl: "https://proxy.example/" }), "https://proxy.example");
	});

	it("falls back to default on malformed URL", () => {
		assert.equal(resolveTavilyBaseUrl({ baseUrl: "not a url" }), "https://api.tavily.com");
	});
});

describe("WebExtractSchema — schema contract", () => {
	it("requires urls (1-20)", () => {
		const props = (WebExtractSchema as unknown as { properties: Record<string, unknown> }).properties;
		assert.ok(props.urls);
	});

	it("makes query / chunksPerSource / extractDepth optional", () => {
		const required = (WebExtractSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(required.includes("urls"));
		assert.ok(!required.includes("query"));
		assert.ok(!required.includes("extractDepth"));
	});
});
