/**
 * Cloud-provider model discovery — best-effort live metadata for a model id
 * that isn't in the static catalog.
 *
 * Used by the never-miss resolver (`agents/model-resolution.ts`): on a
 * `ModelRegistry.find` miss for a cloud provider, we hit the provider's
 * models endpoint to (a) confirm the id exists and (b) read accurate
 * capabilities (context window, vision, reasoning) so the synthesized
 * Model isn't all-defaults.
 *
 * Everything here is defensive: short timeouts, every failure path returns
 * `{ exists: false, meta: {} }` so the caller falls back to template/default
 * synthesis rather than erroring. Local Ollama discovery lives separately in
 * `integrations/ollama.ts` (native /api/tags); this module is for cloud +
 * OpenAI-compatible HTTP endpoints.
 */

const TIMEOUT_MS = 5000;

export interface DiscoveredModelMeta {
	contextWindow?: number;
	reasoning?: boolean;
	vision?: boolean;
}

export interface DiscoveryResult {
	/** True when the provider's model list actually contains this id. */
	exists: boolean;
	/** Best-effort capabilities (empty when unknown). */
	meta: DiscoveredModelMeta;
}

const EMPTY: DiscoveryResult = { exists: false, meta: {} };

/** OpenRouter's public model list — no key needed, rich metadata. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

async function fetchJson(url: string, apiKey?: string): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const res = await fetch(url, { signal: controller.signal, headers });
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * OpenRouter: rich catalog at /api/v1/models. Each entry carries
 * `context_length`, `architecture.input_modalities` (vision), and
 * `supported_parameters` (reasoning).
 */
async function discoverOpenRouter(modelId: string): Promise<DiscoveryResult> {
	const body = (await fetchJson(OPENROUTER_MODELS_URL)) as
		| { data?: Array<Record<string, unknown>> }
		| null;
	const list = body?.data;
	if (!Array.isArray(list)) return EMPTY;
	const entry = list.find((m) => m.id === modelId || m.canonical_slug === modelId);
	if (!entry) return EMPTY;
	const contextWindow =
		typeof entry.context_length === "number" && entry.context_length > 0
			? entry.context_length
			: undefined;
	const arch = entry.architecture as { input_modalities?: unknown } | undefined;
	const modalities = Array.isArray(arch?.input_modalities) ? (arch?.input_modalities as unknown[]) : [];
	const vision = modalities.includes("image");
	const supported = Array.isArray(entry.supported_parameters)
		? (entry.supported_parameters as unknown[])
		: [];
	const reasoning = supported.includes("reasoning") || supported.includes("include_reasoning");
	return { exists: true, meta: { contextWindow, vision, reasoning } };
}

/**
 * Generic OpenAI-compatible `/v1/models` (OpenAI, Groq, Cerebras, DeepSeek,
 * Mistral, xAI, custom endpoints). Most return ids only; Groq additionally
 * includes `context_window`. We confirm existence and pull context_window
 * when present — capabilities otherwise stay unknown (caller defaults them).
 */
async function discoverOpenAICompatible(
	baseUrl: string,
	modelId: string,
	apiKey?: string,
): Promise<DiscoveryResult> {
	// baseUrl is the provider's API root (e.g. https://api.groq.com/openai/v1).
	const url = `${baseUrl.replace(/\/$/, "")}/models`;
	const body = (await fetchJson(url, apiKey)) as { data?: Array<Record<string, unknown>> } | null;
	const list = body?.data;
	if (!Array.isArray(list)) return EMPTY;
	const entry = list.find((m) => m.id === modelId);
	if (!entry) return EMPTY;
	const ctx = entry.context_window ?? entry.context_length;
	const contextWindow = typeof ctx === "number" && ctx > 0 ? ctx : undefined;
	return { exists: true, meta: { contextWindow } };
}

/**
 * Resolve best-effort live metadata for `provider/modelId`. `baseUrl` is the
 * provider's API root (taken from a catalogued template model when available);
 * `apiKey` is the provider's key from auth storage (omit for keyless lists).
 * Never throws — returns `{ exists:false, meta:{} }` on any failure.
 */
export async function discoverCloudModelMeta(
	provider: string,
	modelId: string,
	opts: { baseUrl?: string; apiKey?: string } = {},
): Promise<DiscoveryResult> {
	try {
		if (provider === "openrouter") return await discoverOpenRouter(modelId);
		if (opts.baseUrl) return await discoverOpenAICompatible(opts.baseUrl, modelId, opts.apiKey);
		return EMPTY;
	} catch {
		return EMPTY;
	}
}
