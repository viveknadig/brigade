/**
 * Ollama integration.
 *
 * Ollama runs locally and exposes two parallel APIs:
 *   1. Native Ollama API (`/api/tags`, `/api/generate`) — easiest for discovery.
 *   2. OpenAI-compatible API at `/v1/...` — what we point Pi-AI at for streaming.
 *
 * Pi-AI doesn't ship Ollama as a built-in provider. We register it dynamically
 * via the `~/.brigade/models.json` mechanism Pi exposes for custom providers.
 * Each model the user has pulled becomes a Pi `Model<"openai-completions">`.
 *
 * Capability inference is best-effort — Ollama doesn't tell us a model's
 * context window or whether it reasons. We pattern-match the model name
 * against well-known families and fall back to safe defaults.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

import { tryGetRuntimeContext } from "../storage/runtime-context.js";
import { classifyUrlForSsrf } from "../infra/net/fetch-guard.js";

// 127.0.0.1, not "localhost": on IPv6-preferring hosts "localhost" resolves to
// ::1 while Ollama binds IPv4 → ECONNREFUSED. Use the explicit v4 loopback.
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const TIMEOUT_MS = 5000;
// Placeholder apiKeys Brigade writes for keyless local Ollama. Treated as "no
// real credential" so a re-discovery rewrite doesn't mistake a sentinel for an
// operator-set key worth preserving. Kept in sync with the stream transport's set.
const OLLAMA_SENTINEL_API_KEYS: ReadonlySet<string> = new Set([
	"ollama-local-no-auth-required",
	"ollama-local",
	"ollama",
]);
// Cap simultaneous /api/show probes so a box with many pulled models doesn't
// fire dozens of concurrent requests (which stalls onboarding/rediscovery).
const SHOW_PROBE_CONCURRENCY = 8;

/** Map over items with a bounded worker pool (results keyed by input index). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const idx = next++;
			results[idx] = await fn(items[idx] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
	return results;
}

/** Shape returned by Ollama's `/api/tags` endpoint. */
interface OllamaTagsResponse {
	models?: Array<{
		name: string;
		model?: string;
		size?: number;
		details?: {
			family?: string;
			parameter_size?: string;
			quantization_level?: string;
		};
	}>;
}

export interface OllamaModelSummary {
	id: string;
	name: string;
	sizeBytes?: number;
	family?: string;
	parameterSize?: string;
}

/**
 * Hit Ollama's `/api/tags` and return the user's locally-installed models.
 * Throws a friendly error if the server isn't running or returns no models.
 */
export async function discoverOllamaModels(baseUrl: string = DEFAULT_BASE_URL): Promise<OllamaModelSummary[]> {
	// Strip a trailing `/v1` (someone may pass the OpenAI-compat endpoint) + any
	// trailing slashes, matching fetchOllamaModelInfo + writeOllamaToModelsJson —
	// `/api/tags` is a native path, so `.../v1/api/tags` would 404.
	const url = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`;
	// SSRF guard on the config-driven base URL. allowPrivateNetwork lets local /
	// LAN Ollama through; only genuinely dangerous targets (cloud-metadata /
	// link-local) are refused — no real Ollama listens there.
	const ssrfReason = await classifyUrlForSsrf(url, { allowPrivateNetwork: true });
	if (ssrfReason) {
		throw new Error(`That Ollama server address isn't allowed (${ssrfReason}). Point it at your local or network Ollama.`);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(url, { signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(`Couldn't reach Ollama within ${TIMEOUT_MS / 1000} seconds. Make sure it's running.`);
		}
		throw new Error(`Couldn't reach Ollama. Is it running on this machine?`);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(`Ollama replied with an unexpected error (status ${response.status}).`);
	}

	const body = (await response.json()) as OllamaTagsResponse;
	const models = body.models ?? [];

	if (models.length === 0) {
		throw new Error(
			`Ollama is running but no models are installed yet. Install one (for example: ollama pull llama3.2) and try again.`,
		);
	}

	return models.map((m) => ({
		id: m.model ?? m.name,
		name: m.name,
		sizeBytes: m.size,
		family: m.details?.family,
		parameterSize: m.details?.parameter_size,
	}));
}

/**
 * Best-effort capability guesses based on model id. Ollama exposes no metadata
 * for context window or reasoning — we infer from the family name. Wrong
 * guesses are non-fatal: contextWindow only affects display, and `reasoning`
 * just means we'll set thinkingLevel="low" instead of "off" by default.
 */
export interface InferredCapabilities {
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}

export function inferOllamaModelCapabilities(modelId: string): InferredCapabilities {
	const id = modelId.toLowerCase();

	// Reasoning families. EXTREMELY conservative — only mark a model as
	// reasoning when the name UNAMBIGUOUSLY signals it. False positives here
	// are user-visible failures: marking a non-reasoning model as reasoning
	// makes the loop send `thinking: low` which Ollama rejects with
	// `400 "<model>" does not support thinking`. The runtime has a
	// runWithThinkingFallback wrapper that auto-downgrades, but it's a
	// wasted round trip on the first turn.
	//
	// Specifically EXCLUDED from previous heuristics (the regression case):
	//   - `qwen3-coder*` — code model, no thinking
	//   - `qwen3.5*`     — base chat, not the reasoning fork
	// Originally `^qwen3\b` matched all of these and triggered the bug.
	//
	// Reasoning patterns that ARE safe to mark (dedicated reasoning models — they
	// return STRUCTURED tool_calls + native `thinking` even with thinking on, so
	// no prose-narration risk; anchored so they can't catch a tool-caller sibling):
	//   - `deepseek-r1*`      — explicit r1 (reasoning) line
	//   - `qwq*`              — Qwen with Questions (reasoning fork)
	//   - `*-thinking*`       — explicit thinking variant naming convention
	//   - `gpt-oss*`          — OpenAI open-weight reasoning (harmony format)
	//   - `magistral*`        — Mistral's reasoning model (`^magistral` ≠ `mistral*`)
	//   - `phi4*-reasoning*`  — Phi-4 reasoning variants (bare `phi4` stays non-reasoning)
	//   - `exaone-deep*`      — LG EXAONE Deep reasoning line (`exaone3.5` excluded)
	//   - `smallthinker*`     — SmallThinker ("thinker" ≠ "thinking", so anchored)
	//   - `o1*` / `o3*`       — OpenAI o-series via Ollama (rare)
	// Deliberately EXCLUDED (hybrid think/non-think, default non-reasoning, strong
	// tool-callers): `qwen3`, `cogito`, `deepseek-v3.1` — forcing thinking on risks
	// the prose-narration bug with no automatic net. Opt in via /thinking instead.
	const reasoning =
		/^deepseek-r1\b/.test(id) ||
		/^qwq\b/.test(id) ||
		/-thinking\b/.test(id) ||
		/^gpt-oss\b/.test(id) ||
		/^magistral\b/.test(id) ||
		/^phi4(?:-mini)?-reasoning\b/.test(id) ||
		/^exaone-deep\b/.test(id) ||
		/^smallthinker\b/.test(id) ||
		/\bo1\b/.test(id) ||
		/\bo3\b/.test(id);

	// Vision-capable families — text+image input.
	const vision =
		/^llava\b/.test(id) ||
		/^bakllava\b/.test(id) ||
		/^moondream\b/.test(id) ||
		/^llama3\.2-vision\b/.test(id) ||
		/^minicpm-v\b/.test(id) ||
		/-vision\b/.test(id) ||
		/^gemma[34](?:\.\d+)?[-:]/.test(id); // Gemma 3+ has vision variants

	// Context window — Ollama's defaults vary wildly. Common ranges:
	//   - Most modern open models: 32k-128k
	//   - Older models: 4k-8k
	// We use 32k as a safe middle ground — Pi only uses this for display, not
	// for actual API limits (Ollama itself enforces those server-side).
	const contextWindow = 32_768;
	const maxTokens = 8_192;

	const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];

	return { reasoning, contextWindow, maxTokens, input };
}

/** Subset of Ollama's POST /api/show response we read: the `capabilities`
 *  array (for vision) and `model_info` (for the real context length). */
interface OllamaShowResponse {
	capabilities?: unknown;
	model_info?: Record<string, unknown>;
}

/**
 * Best-effort per-model probe of Ollama's `/api/show`. Returns whether the model
 * accepts images (`vision` capability) and its real trained context window
 * (`<arch>.context_length`). Any failure yields nulls so the caller falls back
 * to the name-heuristic. NOTE: we deliberately do NOT derive `reasoning` from
 * the `thinking` capability — defaulting local models to thinking-on turns them
 * into narrators that emit tool intent as prose instead of structured calls, so
 * reasoning stays name-heuristic (thinking off by default; opt in via /thinking).
 */
async function fetchOllamaModelInfo(
	modelId: string,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<{ vision: boolean | null; contextLength: number | null }> {
	const url = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/show`;
	// SSRF guard (same config-driven base URL as the turn traffic). Best-effort
	// probe: on a blocked target, fall back to the name-heuristic rather than throw.
	if (await classifyUrlForSsrf(url, { allowPrivateNetwork: true })) {
		return { vision: null, contextLength: null };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// Send both keys — modern Ollama reads `model`; older builds read `name`.
			body: JSON.stringify({ model: modelId, name: modelId }),
			signal: controller.signal,
		});
		if (!res.ok) return { vision: null, contextLength: null };
		const body = (await res.json()) as OllamaShowResponse;
		const caps = Array.isArray(body.capabilities)
			? body.capabilities.map((c) => String(c).toLowerCase())
			: null;
		const vision = caps ? caps.includes("vision") : null;
		let contextLength: number | null = null;
		if (body.model_info && typeof body.model_info === "object") {
			for (const [k, v] of Object.entries(body.model_info)) {
				if (k.endsWith(".context_length") && typeof v === "number" && Number.isFinite(v) && v > 0) {
					contextLength = Math.floor(v);
					break;
				}
			}
		}
		return { vision, contextLength };
	} catch {
		return { vision: null, contextLength: null };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Write Brigade's Ollama provider entry into Pi's `~/.brigade/models.json` as a
 * NATIVE provider — `api:"ollama"` (dispatched to our /api/chat transport) with
 * the base URL (no `/v1`). Pi's `ModelRegistry.refresh()` picks this up and
 * exposes the models as regular Pi models from then on.
 *
 * Other providers' entries in the file are left untouched (we only rewrite the
 * `ollama` key). Within the `ollama` entry, discovery OWNS the model list +
 * capabilities (they're re-derived every run), but an operator-set real apiKey
 * and custom headers are PRESERVED across the rewrite — only the keyless sentinel
 * is replaced.
 */
export async function writeOllamaToModelsJson(
	modelsJsonPath: string,
	baseUrl: string,
	models: OllamaModelSummary[],
): Promise<void> {
	let existing: { providers?: Record<string, any> } = { providers: {} };
	try {
		const raw = await fs.readFile(modelsJsonPath, "utf8");
		existing = JSON.parse(raw);
		if (!existing.providers) existing.providers = {};
	} catch {
		// File missing or unparseable — start fresh. Pi treats an absent file as no config.
	}

	// Native transport: base URL WITHOUT /v1 (Brigade registers api:"ollama" → /api/chat).
	const nativeBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

	// Probe /api/show for real vision + context (bounded concurrency, best-effort);
	// fall back to the name-heuristic when unreachable. Reasoning stays name-heuristic.
	const modelDefs = await mapWithConcurrency(models, SHOW_PROBE_CONCURRENCY, async (m) => {
		const caps = inferOllamaModelCapabilities(m.id);
		const info = await fetchOllamaModelInfo(m.id, baseUrl);
		const vision = info.vision ?? caps.input.includes("image");
		const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];
		const contextWindow = info.contextLength ?? caps.contextWindow;
		return {
			id: m.id,
			name: m.name + (m.parameterSize ? ` (${m.parameterSize})` : ""),
			reasoning: caps.reasoning,
			input,
			contextWindow,
			maxTokens: caps.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local = free
			// Per-model baseUrl (belt-and-suspenders): the native stream reads
			// model.baseUrl, so carry it on each model in case Pi's registry doesn't
			// propagate the provider baseUrl onto registry-loaded models.
			baseUrl: nativeBaseUrl,
		};
	});

	// Preserve operator-set auth across a re-discovery rewrite: a remote/authed
	// Ollama proxy may carry a REAL apiKey and/or custom headers under this entry.
	// Discovery owns the model LIST, but must not silently wipe credentials — only
	// fall back to the sentinel when no real key was set.
	const prevOllama = existing.providers!["ollama"] as
		| { apiKey?: unknown; headers?: unknown }
		| undefined;
	const prevApiKey =
		typeof prevOllama?.apiKey === "string" && !OLLAMA_SENTINEL_API_KEYS.has(prevOllama.apiKey)
			? prevOllama.apiKey
			: undefined;
	const prevHeaders =
		prevOllama?.headers && typeof prevOllama.headers === "object" && !Array.isArray(prevOllama.headers)
			? (prevOllama.headers as Record<string, unknown>)
			: undefined;

	existing.providers!["ollama"] = {
		// Native transport: base URL WITHOUT /v1; Brigade registers api:"ollama"
		// (→ /api/chat) so tool-calls + thinking come back structured.
		baseUrl: nativeBaseUrl,
		api: "ollama",
		// Ollama (local) ignores the API key, but Pi requires apiKey to be set when
		// defining custom models for a non-built-in provider. Preserve a real
		// operator key if one was set; otherwise use a sentinel value.
		apiKey: prevApiKey ?? "ollama-local-no-auth-required",
		...(prevHeaders ? { headers: prevHeaders } : {}),
		models: modelDefs,
	};

	// In convex mode resolveModelsPath routes to the OS cache dir, which may
	// not exist yet on a fresh machine (boot only mkdirs it when a "models"
	// blob already exists to materialise) — a bare write would ENOENT inside
	// the wizard's retry loop, making Ollama unpickable. Filesystem mode:
	// ~/.brigade always exists by this point, so this is a no-op.
	await fs.mkdir(path.dirname(modelsJsonPath), { recursive: true });
	await fs.writeFile(modelsJsonPath, JSON.stringify(existing, null, 2), "utf8");

	// Convex mode — the file just written lives in the OS cache (resolveModelsPath
	// routed it there) and is a regenerable mirror; the durable copy is the
	// sealed "models" blob. Push it so a fresh machine re-materialises the
	// catalog at boot.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		await rctx.store.auth
			.writeAuthFileBlob("main", "models" as never, existing as Record<string, unknown>)
			.catch((err: Error) => {
				console.error(`brigade: models catalog write to convex failed — ${err.message}`);
			});
	}
}

/**
 * Runtime re-discovery for local Ollama — enumerates `/api/tags` into the
 * provider config so any pulled model resolves without a manual catalog
 * edit.
 *
 * Called when the model registry MISSES an `ollama/<model>` id: the user has
 * almost certainly `ollama pull`ed a model since onboarding. We re-query the
 * local daemon, merge the full catalog into models.json (native `api:"ollama"`
 * routing + capability inference + zero cost), and return the CANONICAL catalog
 * id of the requested model (or `null` if it isn't installed). Best-effort:
 * never throws — on any failure (daemon down, no models) it returns `null` and
 * the caller surfaces the normal "not registered" guidance.
 *
 * The caller is responsible for `modelRegistry.refresh()` + re-`find()` with the
 * returned canonical id after this resolves non-null, so Pi picks up the
 * freshly-written entries.
 */
export async function rediscoverOllamaModel(
	modelsJsonPath: string,
	modelId: string,
	baseUrl: string = DEFAULT_BASE_URL,
): Promise<string | null> {
	let discovered: OllamaModelSummary[];
	try {
		discovered = await discoverOllamaModels(baseUrl);
	} catch {
		// Daemon unreachable / no models — let the caller surface the standard
		// guidance (run `ollama pull`, check the daemon is up).
		return null;
	}
	if (discovered.length === 0) return null;
	// Honor the "never throws" contract: writeOllamaToModelsJson can throw on an fs
	// error (EACCES/ENOSPC/read-only cache dir). Swallow it → null so the caller
	// surfaces the standard "not registered" guidance instead of an opaque reject.
	try {
		await writeOllamaToModelsJson(modelsJsonPath, baseUrl, discovered);
	} catch {
		return null;
	}
	// Return the CANONICAL catalog id that matched, so the caller re-finds the
	// EXACT id Pi registered (Pi's find is an exact id match — NOT tolerant). We
	// match on id OR name, tolerating a leading `ollama/` provider prefix AND a
	// missing `:latest` tag: a composed ref (`ollama/llama3.2`) or a tag-less id
	// (`qwen3` when only `qwen3:latest` is installed) must resolve to the real
	// catalog id, else it's a hard "model not registered" (Ollama has no synth
	// fallback) EVEN THOUGH the model is pulled + in the catalog.
	const wanted = modelId.trim().replace(/^ollama\//i, "");
	const match = discovered.find(
		(m) =>
			m.id === wanted ||
			m.name === wanted ||
			m.id === `${wanted}:latest` ||
			m.name === `${wanted}:latest`,
	);
	return match ? match.id : null;
}

/**
 * One-time migration: rewrite a pre-existing OpenAI-compat Ollama provider entry
 * (`api:"openai-completions"` + a `/v1` base URL) to the native shape
 * (`api:"ollama"`, base URL without `/v1`). Idempotent + best-effort — existing
 * users would otherwise stay silently on the degraded `/v1` path (no reliable
 * native tool_calls) until they re-onboarded. Returns true when it rewrote.
 */
export async function migrateOllamaProviderToNative(modelsJsonPath: string): Promise<boolean> {
	let parsed: { providers?: Record<string, { api?: unknown; baseUrl?: unknown }> };
	try {
		parsed = JSON.parse(await fs.readFile(modelsJsonPath, "utf8"));
	} catch {
		return false; // no/invalid file → nothing to migrate
	}
	const entry = parsed.providers?.ollama;
	if (!entry) return false;
	const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "";
	const needsMigration = entry.api !== "ollama" || /\/v1\/?$/i.test(baseUrl);
	if (!needsMigration) return false;
	entry.api = "ollama";
	if (baseUrl) entry.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
	try {
		await fs.writeFile(modelsJsonPath, JSON.stringify(parsed, null, 2), "utf8");
	} catch {
		return false;
	}
	// Convex mode: the file above is the regenerable OS-cache mirror; the DURABLE
	// copy is the sealed "models" blob. Push the migrated catalog there too, or the
	// migration fixes only the cache and the next boot re-materialises the stale
	// blob (openai-completions/v1) — migration would silently re-run forever and
	// never persist. Mirrors writeOllamaToModelsJson's blob push.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		await rctx.store.auth
			.writeAuthFileBlob("main", "models" as never, parsed as Record<string, unknown>)
			.catch((err: Error) => {
				console.error(`brigade: models catalog migrate→convex failed — ${err.message}`);
			});
	}
	return true;
}
