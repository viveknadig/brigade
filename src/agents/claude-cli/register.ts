// Register the claude-cli transport into Pi's API-provider registry so a model
// with `api: "claude-cli"` dispatches to the subprocess stream fn — exactly
// like the native Ollama transport (`ollama-native/register.ts`). Also exposes
// a synthesizer that resolves a `claude-cli/<model>` ref to a Pi `Model`
// object (no models.json write needed; the never-miss resolver calls it).

import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
	CLAUDE_CLI_API,
	CLAUDE_CLI_DEFAULT_MODEL,
	CLAUDE_CLI_MODELS,
	CLAUDE_CLI_PROVIDER,
	stripClaudeCliPrefix,
} from "./catalog.js";
import { createClaudeCliStreamFn } from "./stream.js";

const REGISTRY_SOURCE_ID = "brigade-claude-cli";

/**
 * Idempotently register the claude-cli transport for `api: "claude-cli"`.
 * Guards on the LIVE registry (`getApiProvider`) rather than a sticky flag, so
 * it self-heals after Pi's `resetApiProviders()` (fired by `ModelRegistry
 * .refresh()`, `AgentSession.reload()`, and register/unregisterProvider). Safe
 * to call at boot, per turn, and before any isolated claude-cli session.
 * Returns true when it actually registered (was absent), false when already up.
 */
export function ensureClaudeCliApiRegistered(): boolean {
	if (getApiProvider(CLAUDE_CLI_API)) return false;
	const streamFn: StreamFn = createClaudeCliStreamFn();
	registerApiProvider(
		{
			api: CLAUDE_CLI_API,
			// One transport serves both surfaces (the CLI has no separate simple-
			// completion path). Cast: the registry's generic stream types are
			// stricter than our loose StreamFn.
			stream: streamFn as never,
			streamSimple: streamFn as never,
		},
		REGISTRY_SOURCE_ID,
	);
	return true;
}

/** Loose Pi `Model` shape — we synthesize rather than construct from a class. */
export type SynthClaudeCliModel = Record<string, unknown> & {
	provider: string;
	id: string;
	api: string;
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Synthesize a Pi `Model` for a `claude-cli` model id. A catalogued snapshot
 * uses its declared metadata; an unknown id (a newer release the operator
 * names explicitly) synthesizes a sensible default so a turn is never blocked
 * on "model not registered" — the CLI validates the concrete id at spawn time.
 * Cost is zero (a subscription turn draws no per-token charge).
 */
export function synthClaudeCliModel(modelId: string): SynthClaudeCliModel {
	const id = stripClaudeCliPrefix(modelId) || CLAUDE_CLI_DEFAULT_MODEL;
	const known = CLAUDE_CLI_MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
	return {
		provider: CLAUDE_CLI_PROVIDER,
		id,
		name: known?.name ?? `${id} (subscription)`,
		api: CLAUDE_CLI_API,
		// The transport is a subprocess, not an HTTP endpoint — but a `baseUrl`
		// MUST still be present + a string: Pi's provider-attribution runs on
		// every model (`model.provider === "openrouter" || model.baseUrl.includes(
		// …)`) and crashes with "Cannot read properties of undefined (reading
		// 'includes')" on a missing baseUrl. This placeholder is never dialed.
		baseUrl: "https://api.anthropic.com",
		reasoning: known?.reasoning ?? /opus|sonnet|fable/i.test(id),
		// VISION. Every Claude model this backend can name is vision-capable, and the
		// binary accepts image content blocks on `--input-format stream-json` (verified
		// live: Opus 4.8 through `claude -p` describes an attached PNG in detail).
		//
		// This said `["text"]` for as long as the backend flattened messages to plain
		// text and replaced attached pictures with the literal string "[image omitted]".
		// That made the declaration honest but the capability wrong — and because the
		// agent loop gates inline images on exactly this field
		// (`resolveInboundImagePrompt`), the operator's screenshot was silently DROPPED
		// and the TUI told them "this model can't see images" about Opus.
		input: ["text", "image"] as ("text" | "image")[],
		cost: { ...ZERO_COST },
		contextWindow: known?.contextWindow ?? 200_000,
		maxTokens: known?.maxTokens ?? 32_000,
	};
}

/** True when a provider id routes to the claude-cli backend. */
export function isClaudeCliProvider(provider: string | undefined): boolean {
	return (provider ?? "").trim().toLowerCase() === CLAUDE_CLI_PROVIDER;
}

/**
 * The catalogued claude-cli models as Pi `Model` objects (static fallback), for
 * merging into the gateway's `/model` list. Callers should gate on
 * `isClaudeCliAvailable()` first — advertise it only when the binary exists.
 */
export function listClaudeCliModels(): SynthClaudeCliModel[] {
	return CLAUDE_CLI_MODELS.map((m) => synthClaudeCliModel(m.id));
}

/**
 * Like `listClaudeCliModels` but resolves the account's LIVE model set from
 * Anthropic's `/v1/models` (via the subscription token) so the picker reflects
 * exactly what the subscription can run — including models newer than the
 * static catalog (Fable 5, Sonnet 5, …). Falls back to the static list on any
 * failure. Async; call from the gateway's already-async `list-models`.
 */
export async function listClaudeCliModelsLive(): Promise<SynthClaudeCliModel[]> {
	const { fetchClaudeCliModelIds } = await import("./models-live.js");
	const ids = await fetchClaudeCliModelIds();
	return ids.map((id) => synthClaudeCliModel(id));
}
