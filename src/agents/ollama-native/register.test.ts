import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getApiProvider } from "@earendil-works/pi-ai";

import { ensureOllamaNativeApiRegistered, OLLAMA_NATIVE_API } from "./register.js";

describe("ensureOllamaNativeApiRegistered", () => {
	it("registers api:\"ollama\" into Pi's api-registry with a stream fn, idempotently", () => {
		const first = ensureOllamaNativeApiRegistered();
		assert.equal(first, true, "first call registers");

		const provider = getApiProvider(OLLAMA_NATIVE_API) as { stream?: unknown; streamSimple?: unknown } | undefined;
		assert.ok(provider, "getApiProvider(\"ollama\") now resolves");
		assert.equal(typeof provider?.stream, "function");
		assert.equal(typeof provider?.streamSimple, "function");

		assert.equal(ensureOllamaNativeApiRegistered(), false, "second call is a no-op");
	});
});
