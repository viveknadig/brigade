/**
 * Never-miss model resolution — a layered resolution net (static registry
 * find → discovery → dynamic resolve → configured fallback). The
 * invariant: a `ModelRegistry.find` returning `undefined` is NEVER
 * terminal while we can still discover or synthesize a usable Model.
 *
 * Resolution order (each step only runs if earlier ones miss):
 *   1. Static registry find — Pi built-in catalog + models.json.
 *   2. Local discovery — Ollama re-queries /api/tags + refresh (the model was
 *      `ollama pull`ed after onboarding).
 *   3. Live cloud discovery — hit the provider's models endpoint (OpenRouter
 *      /api/v1/models, OpenAI-compatible /v1/models) for accurate metadata.
 *   4. Synthesize-from-template — clone a catalogued model for the SAME
 *      provider (inherits the correct api/baseUrl/auth routing), swap the id,
 *      and apply discovered-or-default capabilities. This is what lets an
 *      uncatalogued-but-valid cloud model resolve; the real API call then
 *      validates the id (a typo surfaces as the provider's own error).
 *   5. Synthesize-from-config — for a `custom` provider configured in
 *      models.json (baseUrl/api), build a Model from that config.
 *
 * Returns the resolved/synthesized Model, or `undefined` if even synthesis is
 * impossible (no template + no provider config) — the only legitimate miss.
 */

import * as fs from "node:fs";

import { isLikelyReasoningModelId } from "../core/model-caps.js";
import { rediscoverOllamaModel } from "../integrations/ollama.js";
import { discoverCloudModelMeta, type DiscoveredModelMeta } from "../integrations/provider-discovery.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Loose Pi Model shape — we clone templates rather than construct from scratch. */
type LooseModel = Record<string, unknown> & {
	provider?: string;
	id?: string;
	api?: string;
	baseUrl?: string;
	contextWindow?: number;
	input?: unknown;
};

interface LooseRegistry {
	find?: (provider: string, modelId: string) => unknown;
	getAvailable?: () => unknown[];
	refresh?: () => void;
}

interface LooseAuthStorage {
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export interface ResolveModelArgs {
	modelRegistry: unknown;
	provider: string;
	modelId: string;
	/** Path to models.json (for Ollama re-discovery writes). */
	modelsFile: string;
	/** Auth storage to read the provider key for authenticated /models calls. */
	authStorage?: unknown;
}

/**
 * Resolve `provider/modelId` to a usable Model, discovering or synthesizing
 * one on a static miss. See module header for the ordered net.
 */
export async function resolveModelNeverMiss(args: ResolveModelArgs): Promise<unknown | undefined> {
	const { provider, modelId, modelsFile } = args;
	const registry = args.modelRegistry as LooseRegistry;
	if (typeof registry.find !== "function") return undefined;

	// 1. Static.
	const direct = registry.find(provider, modelId);
	if (direct) return direct;

	// 2. Local Ollama discovery (writes models.json + refresh, then re-find).
	if (provider === "ollama") {
		const found = await rediscoverOllamaModel(modelsFile, modelId).catch(() => false);
		if (found) {
			registry.refresh?.();
			const reFound = registry.find(provider, modelId);
			if (reFound) return reFound;
		}
		// Ollama daemon unreachable / model not pulled → no synth (a local model
		// the daemon doesn't have can't be served). Surface the normal error.
		return undefined;
	}

	// Find a catalogued template for this provider — it carries the correct
	// transport (api/baseUrl) + auth routing, which we inherit for the synth.
	const template = findProviderTemplate(registry, provider);

	// 3. Live cloud discovery for accurate metadata (best-effort).
	const apiKey = await readApiKey(args.authStorage, provider);
	const discovery = await discoverCloudModelMeta(provider, modelId, {
		baseUrl: typeof template?.baseUrl === "string" ? template.baseUrl : undefined,
		apiKey,
	});

	// 4. Synthesize from the provider template (clone routing, override the
	// per-model fields). We synthesize even when discovery couldn't confirm
	// existence — a catch-all dynamic resolver pattern. The live API call
	// validates the id and surfaces a precise provider error for a genuine
	// typo, which is strictly better than an opaque "not registered".
	if (template) {
		return synthFromTemplate(template, modelId, discovery.meta);
	}

	// 5. Synthesize from a configured `custom`/OpenAI-compatible provider in
	// models.json (no built-in template exists for it).
	const configured = readProviderConfigFromModelsJson(modelsFile, provider);
	if (configured?.baseUrl && configured?.api) {
		return synthFromConfig(provider, modelId, configured, discovery.meta);
	}

	// No template, no config — the only legitimate miss.
	return undefined;
}

function findProviderTemplate(registry: LooseRegistry, provider: string): LooseModel | undefined {
	if (typeof registry.getAvailable !== "function") return undefined;
	let list: unknown[];
	try {
		list = registry.getAvailable() ?? [];
	} catch {
		return undefined;
	}
	return list.find((m): m is LooseModel => {
		return !!m && typeof m === "object" && (m as LooseModel).provider === provider;
	});
}

function synthFromTemplate(template: LooseModel, modelId: string, meta: DiscoveredModelMeta): LooseModel {
	const reasoning = meta.reasoning ?? isLikelyReasoningModelId(modelId);
	const input: ("text" | "image")[] = meta.vision
		? ["text", "image"]
		: Array.isArray(template.input)
			? (template.input as ("text" | "image")[])
			: ["text"];
	return {
		// Inherit transport-critical fields (provider, api, baseUrl, headers) from
		// the template so routing + auth resolve exactly as for a real model.
		...template,
		id: modelId,
		name: modelId,
		reasoning,
		input,
		// Cost is per-model and unknown for a synthesized id — report zero rather
		// than the template model's (wrong) pricing. Display-only.
		cost: { ...ZERO_COST },
		contextWindow: meta.contextWindow ?? template.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

interface ConfiguredProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
}

function synthFromConfig(
	provider: string,
	modelId: string,
	cfg: ConfiguredProvider,
	meta: DiscoveredModelMeta,
): LooseModel {
	return {
		provider,
		id: modelId,
		name: modelId,
		api: cfg.api,
		baseUrl: cfg.baseUrl,
		reasoning: meta.reasoning ?? isLikelyReasoningModelId(modelId),
		input: meta.vision ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		contextWindow: meta.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function readProviderConfigFromModelsJson(modelsFile: string, provider: string): ConfiguredProvider | undefined {
	try {
		const raw = fs.readFileSync(modelsFile, "utf8");
		const parsed = JSON.parse(raw) as { providers?: Record<string, ConfiguredProvider> };
		return parsed.providers?.[provider];
	} catch {
		return undefined;
	}
}

async function readApiKey(authStorage: unknown, provider: string): Promise<string | undefined> {
	const store = authStorage as LooseAuthStorage | undefined;
	if (!store || typeof store.getApiKey !== "function") return undefined;
	try {
		const key = await store.getApiKey(provider);
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}
