import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { discoverCloudModelMeta } from "./provider-discovery.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(payload: unknown, ok = true): void {
	globalThis.fetch = (async () =>
		({
			ok,
			json: async () => payload,
		}) as unknown as Response) as typeof fetch;
}

describe("discoverCloudModelMeta — OpenRouter parsing", () => {
	it("extracts context window, vision, and reasoning from /api/v1/models", async () => {
		mockFetch({
			data: [
				{
					id: "vendor/cool-model",
					context_length: 256000,
					architecture: { input_modalities: ["text", "image"] },
					supported_parameters: ["reasoning", "tools"],
				},
			],
		});
		const res = await discoverCloudModelMeta("openrouter", "vendor/cool-model");
		assert.equal(res.exists, true);
		assert.equal(res.meta.contextWindow, 256000);
		assert.equal(res.meta.vision, true);
		assert.equal(res.meta.reasoning, true);
	});

	it("returns exists:false when the id is absent from the list", async () => {
		mockFetch({ data: [{ id: "vendor/other" }] });
		const res = await discoverCloudModelMeta("openrouter", "vendor/missing");
		assert.equal(res.exists, false);
		assert.deepEqual(res.meta, {});
	});

	it("never throws on a network/parse failure (returns empty)", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const res = await discoverCloudModelMeta("openrouter", "vendor/x");
		assert.deepEqual(res, { exists: false, meta: {} });
	});
});

describe("discoverCloudModelMeta — generic OpenAI-compatible", () => {
	it("reads context_window (Groq-style) from <baseUrl>/models", async () => {
		mockFetch({ data: [{ id: "llama-3.3-70b", context_window: 131072 }] });
		const res = await discoverCloudModelMeta("groq", "llama-3.3-70b", {
			baseUrl: "https://api.groq.com/openai/v1",
			apiKey: "k",
		});
		assert.equal(res.exists, true);
		assert.equal(res.meta.contextWindow, 131072);
	});

	it("returns empty for a non-openrouter provider with no baseUrl (no fetch)", async () => {
		// No baseUrl → no endpoint to hit → empty, without touching the network.
		mockFetch({ data: [{ id: "should-not-be-read" }] });
		const res = await discoverCloudModelMeta("groq", "anything");
		assert.deepEqual(res, { exists: false, meta: {} });
	});
});
