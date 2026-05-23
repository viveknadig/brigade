/**
 * Tests for the Exa search provider — identity + key gating.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createExaSearchProvider } from "./exa.js";

describe("createExaSearchProvider", () => {
	const provider = createExaSearchProvider();

	it("declares identity", () => {
		assert.equal(provider.id, "exa");
		assert.deepEqual(provider.envVars, ["EXA_API_KEY"]);
	});

	it("isConfigured gates on EXA_API_KEY", () => {
		assert.equal(provider.isConfigured({} as never, {} as never), false);
		assert.equal(
			provider.isConfigured({} as never, { EXA_API_KEY: "exa-x" } as never),
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
			env: { EXA_API_KEY: "exa-x" } as never,
			workspaceDir: "/tmp",
		});
		assert.ok(def);
	});
});
