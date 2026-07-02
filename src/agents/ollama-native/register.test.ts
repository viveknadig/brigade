import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getApiProvider, resetApiProviders } from "@earendil-works/pi-ai";

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

	it("self-heals after resetApiProviders() wipes the custom provider (guards on the LIVE registry, not a sticky flag)", () => {
		// Pi's ModelRegistry.refresh() calls resetApiProviders(), which clears ALL
		// dynamically-registered API providers and re-adds only the built-ins. A
		// sticky "already registered" boolean would make Brigade skip re-registration
		// and every Ollama turn after the first refresh would fail to dispatch. The
		// live-registry guard must re-register instead.
		ensureOllamaNativeApiRegistered();
		assert.ok(getApiProvider(OLLAMA_NATIVE_API), "registered before the wipe");

		resetApiProviders(); // simulates ModelRegistry.refresh()
		assert.equal(getApiProvider(OLLAMA_NATIVE_API), undefined, "wiped by resetApiProviders()");

		assert.equal(ensureOllamaNativeApiRegistered(), true, "re-registers after the wipe");
		assert.ok(getApiProvider(OLLAMA_NATIVE_API), "the native transport is live again");
	});
});
