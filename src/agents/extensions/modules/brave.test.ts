/**
 * Tests for the Brave search provider — provider identity, key resolution,
 * isConfigured gating. Network-touching paths are not exercised here.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createBraveSearchProvider } from "./brave.js";

describe("createBraveSearchProvider", () => {
	const provider = createBraveSearchProvider();

	it("declares identity + lower-than-Firecrawl-search priority", () => {
		assert.equal(provider.id, "brave");
		assert.equal(provider.label, "Brave Search");
		assert.deepEqual(provider.envVars, ["BRAVE_API_KEY"]);
		// Brave (30) beats Firecrawl search (50) when both configured.
		assert.ok((provider.autoDetectOrder ?? 999) < 50);
	});

	it("isConfigured returns false without key", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
	});

	it("isConfigured returns true with env key", () => {
		assert.equal(
			provider.isConfigured({} as never, { BRAVE_API_KEY: "BSA-x" } as never),
			true,
		);
	});

	it("isConfigured prefers config-side key", () => {
		const cfg = {
			tools: {
				web: {
					search: { providers: { brave: { apiKey: "BSA-cfg" } } },
				},
			},
		};
		assert.equal(provider.isConfigured(cfg as never, {} as never), true);
	});

	it("createTool returns null without key", () => {
		const ctx = { config: {} as never, env: {} as never, workspaceDir: "/tmp" };
		assert.equal(provider.createTool(ctx), null);
	});

	it("createTool returns definition with key", () => {
		const ctx = {
			config: {} as never,
			env: { BRAVE_API_KEY: "BSA-x" } as never,
			workspaceDir: "/tmp",
		};
		const def = provider.createTool(ctx);
		assert.ok(def);
		assert.match(def?.description ?? "", /Brave/i);
	});
});
