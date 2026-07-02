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

let registered = false;

/**
 * Idempotently register the native Ollama transport for `api: "ollama"`.
 * No-op if some provider already owns that API string (e.g. a re-entrant call)
 * or if it's been registered before in this process. Safe to call at boot and
 * per turn.
 */
export function ensureOllamaNativeApiRegistered(): boolean {
	if (registered || getApiProvider(OLLAMA_NATIVE_API)) {
		registered = true;
		return false;
	}
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
	registered = true;
	return true;
}
