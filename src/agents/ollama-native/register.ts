// Register the native Ollama transport into Pi's API-provider registry so that
// any model with `api: "ollama"` dispatches to our /api/chat stream function —
// exactly like a Pi built-in provider. Pi's `Api` type is `KnownApi | (string
// & {})`, so "ollama" is a valid custom API string; `registerApiProvider`
// (exported by @earendil-works/pi-ai) is the public seam for wiring it.
//
// This makes native Ollama first-class: the agent loop, sub-agents, and any
// `streamSimple` caller all resolve `getApiProvider("ollama")` to the native
// transport, without forking Pi.

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { createOllamaStreamFn } from "./stream.js";

/** The custom Pi API string Brigade registers Ollama models under. */
export const OLLAMA_NATIVE_API = "ollama";

const REGISTRY_SOURCE_ID = "brigade-ollama-native";

/**
 * Idempotently register the native Ollama transport for `api: "ollama"`.
 * Guards on the LIVE registry (getApiProvider) — NOT a sticky flag — so it
 * self-heals: Pi's `ModelRegistry.refresh()` calls `resetApiProviders()`, which
 * wipes dynamically-registered API providers; a subsequent call here re-registers.
 * Fully synchronous, so it's race-free within a process. Safe to call at boot,
 * per turn, and before any isolated Ollama session.
 */
export function ensureOllamaNativeApiRegistered(): boolean {
	if (getApiProvider(OLLAMA_NATIVE_API)) return false;
	const streamFn: StreamFn = createOllamaStreamFn();
	registerApiProvider(
		{
			api: OLLAMA_NATIVE_API,
			// Both surfaces route to the same native stream fn (Ollama has no
			// separate simple-completion endpoint). Cast: the registry's generic
			// stream types are stricter than our loose StreamFn.
			stream: streamFn as never,
			streamSimple: streamFn as never,
		},
		REGISTRY_SOURCE_ID,
	);
	return true;
}
