/**
 * Tests for the Perplexity search provider — identity + key gating.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createPerplexitySearchProvider } from "./perplexity.js";

describe("createPerplexitySearchProvider", () => {
	const provider = createPerplexitySearchProvider();

	it("declares identity", () => {
		assert.equal(provider.id, "perplexity");
		assert.deepEqual(provider.envVars, ["PERPLEXITY_API_KEY"]);
	});

	it("isConfigured gates on PERPLEXITY_API_KEY", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
		assert.equal(
			provider.isConfigured({} as never, { PERPLEXITY_API_KEY: "pplx-x" } as never),
			true,
		);
	});

	it("createTool returns null without key", () => {
		assert.equal(
			provider.createTool({ config: {} as never, env: {} as never, workspaceDir: "/tmp" }),
			null,
		);
	});

	it("createTool returns definition with key", () => {
		const def = provider.createTool({
			config: {} as never,
			env: { PERPLEXITY_API_KEY: "pplx-x" } as never,
			workspaceDir: "/tmp",
		});
		assert.ok(def);
	});
});
