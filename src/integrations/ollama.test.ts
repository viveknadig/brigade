import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	inferOllamaModelCapabilities,
	migrateOllamaProviderToNative,
	rediscoverOllamaModel,
	writeOllamaToModelsJson,
} from "./ollama.js";

describe("inferOllamaModelCapabilities — reasoning name-heuristic", () => {
	// The crux of native tool-calling: the common tool-callers must NOT be marked
	// reasoning, or the loop defaults them to thinking-ON and they narrate tool
	// calls as prose instead of emitting structured calls.
	const notReasoning = [
		"qwen3",
		"qwen3:latest",
		"qwen3-coder",
		"qwen3-coder:30b",
		"qwen3.5",
		"llama3.2",
		"llama3.1:8b",
		"mistral", // must NOT be caught by the ^magistral rule
		"mistral-nemo",
		"gemma3",
		"phi4", // bare phi4 is an instruct tool-caller, NOT phi4-reasoning
		"phi4-mini",
		"cogito", // hybrid — default non-reasoning, opt in via /thinking
		"deepseek-v3.1", // hybrid — default non-reasoning
	];
	for (const id of notReasoning) {
		it(`marks ${id} as NON-reasoning (thinking stays off)`, () => {
			assert.equal(inferOllamaModelCapabilities(id).reasoning, false);
		});
	}

	const isReasoning = [
		"deepseek-r1",
		"deepseek-r1:7b",
		"qwq",
		"qwq:32b",
		"qwen3-thinking",
		"gpt-oss",
		"gpt-oss:20b",
		"gpt-oss:120b",
		"magistral",
		"phi4-reasoning",
		"phi4-mini-reasoning",
		"exaone-deep",
		"smallthinker",
		"o1",
		"o3-mini",
	];
	for (const id of isReasoning) {
		it(`marks ${id} as reasoning (thinking on)`, () => {
			assert.equal(inferOllamaModelCapabilities(id).reasoning, true);
		});
	}

	it("marks vision families as text+image input", () => {
		assert.deepEqual(inferOllamaModelCapabilities("llava").input, ["text", "image"]);
		assert.deepEqual(inferOllamaModelCapabilities("llama3.2-vision").input, ["text", "image"]);
		assert.deepEqual(inferOllamaModelCapabilities("qwen3").input, ["text"]);
	});
});

describe("migrateOllamaProviderToNative", () => {
	let dir: string;
	let file: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "brigade-ollama-mig-"));
		file = path.join(dir, "models.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("rewrites a legacy /v1 openai-completions entry to the native shape, then is idempotent", async () => {
		await writeFile(
			file,
			JSON.stringify({
				providers: {
					ollama: {
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:11434/v1",
						apiKey: "ollama-local-no-auth-required",
						models: [{ id: "qwen3", name: "qwen3" }],
					},
				},
			}),
			"utf8",
		);

		assert.equal(await migrateOllamaProviderToNative(file), true, "migrates the legacy entry");
		const after = JSON.parse(await readFile(file, "utf8"));
		assert.equal(after.providers.ollama.api, "ollama", "api flipped to native");
		assert.equal(after.providers.ollama.baseUrl, "http://127.0.0.1:11434", "/v1 stripped from base URL");
		assert.equal(after.providers.ollama.models[0].id, "qwen3", "models preserved");

		assert.equal(await migrateOllamaProviderToNative(file), false, "second run is a no-op");
	});

	it("returns false (no rewrite) when already native", async () => {
		await writeFile(
			file,
			JSON.stringify({ providers: { ollama: { api: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] } } }),
			"utf8",
		);
		assert.equal(await migrateOllamaProviderToNative(file), false);
	});

	it("returns false when there is no ollama provider, or no/invalid file", async () => {
		await writeFile(file, JSON.stringify({ providers: { anthropic: {} } }), "utf8");
		assert.equal(await migrateOllamaProviderToNative(file), false, "no ollama entry");

		await writeFile(file, "not json", "utf8");
		assert.equal(await migrateOllamaProviderToNative(file), false, "invalid file");

		assert.equal(await migrateOllamaProviderToNative(path.join(dir, "missing.json")), false, "missing file");
	});

	it("migrates api even when the base URL is already clean (api was the only stale field)", async () => {
		await writeFile(
			file,
			JSON.stringify({ providers: { ollama: { api: "openai-completions", baseUrl: "http://127.0.0.1:11434", models: [] } } }),
			"utf8",
		);
		assert.equal(await migrateOllamaProviderToNative(file), true);
		const after = JSON.parse(await readFile(file, "utf8"));
		assert.equal(after.providers.ollama.api, "ollama");
		assert.equal(after.providers.ollama.baseUrl, "http://127.0.0.1:11434");
	});

	it("preserves an operator-set real apiKey + headers across a discovery rewrite", async () => {
		// A remote/authed Ollama proxy may carry a real token; discovery owns the
		// model list but must not silently wipe credentials.
		await writeFile(
			file,
			JSON.stringify({
				providers: {
					ollama: {
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:11434/v1",
						apiKey: "real-proxy-token",
						headers: { "X-Proxy": "abc" },
						models: [],
					},
				},
			}),
			"utf8",
		);
		await writeOllamaToModelsJson(file, "http://127.0.0.1:11434", [{ id: "qwen3:latest", name: "qwen3:latest" }] as never);
		const after = JSON.parse(await readFile(file, "utf8"));
		assert.equal(after.providers.ollama.apiKey, "real-proxy-token", "real key preserved");
		assert.deepEqual(after.providers.ollama.headers, { "X-Proxy": "abc" }, "headers preserved");
		assert.equal(after.providers.ollama.api, "ollama", "still flipped to native");
	});

	it("replaces the keyless sentinel apiKey (does not treat it as a real key)", async () => {
		await writeFile(
			file,
			JSON.stringify({ providers: { ollama: { api: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "ollama", models: [] } } }),
			"utf8",
		);
		await writeOllamaToModelsJson(file, "http://127.0.0.1:11434", [{ id: "qwen3:latest", name: "qwen3:latest" }] as never);
		const after = JSON.parse(await readFile(file, "utf8"));
		assert.equal(after.providers.ollama.apiKey, "ollama-local-no-auth-required");
	});
});

describe("rediscoverOllamaModel — returns the CANONICAL catalog id (never-miss)", () => {
	const realFetch = globalThis.fetch;
	let dir: string;
	let file: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "brigade-ollama-redis-"));
		file = path.join(dir, "models.json");
	});
	afterEach(async () => {
		globalThis.fetch = realFetch;
		await rm(dir, { recursive: true, force: true });
	});

	function mockTags(models: Array<{ model: string; name: string }>): void {
		globalThis.fetch = (async (url: string) => {
			if (String(url).includes("/api/tags")) {
				return { ok: true, status: 200, json: async () => ({ models }) };
			}
			// /api/show → 404 so capability inference falls back to the name heuristic.
			return { ok: false, status: 404, text: async () => "" };
		}) as unknown as typeof fetch;
	}

	it("resolves a tag-less request id to the installed :latest canonical id", async () => {
		mockTags([{ model: "qwen3:latest", name: "qwen3:latest" }]);
		assert.equal(await rediscoverOllamaModel(file, "qwen3"), "qwen3:latest");
	});

	it("strips a leading ollama/ prefix and resolves the canonical id", async () => {
		mockTags([{ model: "llama3.2:latest", name: "llama3.2:latest" }]);
		assert.equal(await rediscoverOllamaModel(file, "ollama/llama3.2"), "llama3.2:latest");
	});

	it("returns the exact id when the request already matches a catalog id", async () => {
		mockTags([{ model: "qwen3:8b", name: "qwen3:8b" }]);
		assert.equal(await rediscoverOllamaModel(file, "qwen3:8b"), "qwen3:8b");
	});

	it("returns null when the requested model isn't installed", async () => {
		mockTags([{ model: "qwen3:latest", name: "qwen3:latest" }]);
		assert.equal(await rediscoverOllamaModel(file, "mistral"), null);
	});

	it("returns null (no throw) when the daemon is unreachable", async () => {
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		assert.equal(await rediscoverOllamaModel(file, "qwen3"), null);
	});
});
