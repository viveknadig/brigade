/**
 * Firecrawl web-fetch + web-search provider — bundled, API-key-gated.
 *
 * **Fetch path** falls back from the built-in raw HTTP fetcher when:
 *   - the page is JS-heavy (built-in returns empty / shell HTML)
 *   - the upstream blocks Node's default User-Agent
 *   - the built-in throws a network error
 *   - Readability bails on a JS-heavy page (provider beats regex fallback)
 *
 * Hits `https://api.firecrawl.dev/v2/scrape` with the configured API key,
 * asks for `markdown` format, and returns the markdown + metadata.
 *
 * **Search path** is the `/v2/search` endpoint — used as the default
 * `web_search` provider when Firecrawl is configured. The operator can pin a
 * different search provider via `tools.web.search.provider: "<id>"`.
 *
 * Operator config (set in `brigade.json`):
 *   tools.web.fetch.providers.firecrawl: {
 *     apiKey?, proxy?, storeInCache?, maxAgeMs?, timeoutSeconds?, onlyMainContent?
 *   }
 *   tools.web.search.providers.firecrawl: {
 *     apiKey? (shared with fetch), sources?, categories?, scrapeResults?
 *   }
 *
 * Sign-up at https://firecrawl.dev (free tier ~500 pages/mo).
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebFetchProvider,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import type { BrigadeConfig } from "../../../config/io.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	mergeSignals,
	resolveSiteName,
	sanitizeHeaderToken,
	wrapSearchHit,
} from "./web-provider-helpers.js";

const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";

/* ─────────────────────────── shared key resolver ─────────────────────────── */

/** Pull the Firecrawl API key from config OR env. Sanitized for safe header use. */
function resolveFirecrawlApiKey(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): string | undefined {
	const cfgKey = (
		cfg as {
			tools?: { web?: { fetch?: { providers?: { firecrawl?: { apiKey?: string } } } } };
		}
	).tools?.web?.fetch?.providers?.firecrawl?.apiKey?.trim();
	const envKey = env?.FIRECRAWL_API_KEY?.trim();
	const raw = cfgKey || envKey;
	if (!raw) return undefined;
	const cleaned = sanitizeHeaderToken(raw);
	return cleaned.length > 0 ? cleaned : undefined;
}

/* ─────────────────────────── operator config readers ─────────────────────────── */

interface FirecrawlFetchConfig {
	apiKey?: string;
	proxy?: "auto" | "basic" | "stealth";
	storeInCache?: boolean;
	maxAgeMs?: number;
	timeoutSeconds?: number;
	onlyMainContent?: boolean;
}

interface FirecrawlSearchConfig {
	apiKey?: string;
	sources?: string[];
	categories?: string[];
	scrapeResults?: boolean;
}

function readFirecrawlFetchConfig(cfg: BrigadeConfig): FirecrawlFetchConfig {
	const slot = (
		cfg as {
			tools?: { web?: { fetch?: { providers?: { firecrawl?: FirecrawlFetchConfig } } } };
		}
	).tools?.web?.fetch?.providers?.firecrawl;
	return slot ?? {};
}

function readFirecrawlSearchConfig(cfg: BrigadeConfig): FirecrawlSearchConfig {
	const slot = (
		cfg as {
			tools?: { web?: { search?: { providers?: { firecrawl?: FirecrawlSearchConfig } } } };
		}
	).tools?.web?.search?.providers?.firecrawl;
	return slot ?? {};
}

/* ─────────────────────────── shared HTTP helper ─────────────────────────── */

interface PostFirecrawlOptions {
	endpoint: string;
	apiKey: string;
	body: Record<string, unknown>;
	timeoutMs: number;
	signal?: AbortSignal;
}

async function postFirecrawl(opts: PostFirecrawlOptions): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);
	timer.unref?.();
	const combined = mergeSignals([opts.signal, controller.signal]);
	try {
		const response = await fetch(opts.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify(opts.body),
			signal: combined,
		});
		const { text: rawBody } = await readResponseText(response.body, 2_000_000);
		if (response.status !== 200) {
			// Strip control chars and cap before surfacing — the upstream body
			// is attacker-influenceable text and lands in a thrown Error.message.
			const safeSnippet = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
			throw new Error(`firecrawl: HTTP ${response.status} — ${safeSnippet}`);
		}
		const json = (() => {
			try {
				return JSON.parse(rawBody) as Record<string, unknown>;
			} catch {
				return null;
			}
		})();
		if (!json || json.success === false) {
			const errMsg = typeof (json as { error?: unknown } | null)?.error === "string"
				? (json as { error: string }).error
				: "firecrawl returned no success payload";
			throw new Error(`firecrawl: ${errMsg}`);
		}
		return json;
	} finally {
		clearTimeout(timer);
	}
}

/* ─────────────────────────── fetch provider ─────────────────────────── */

function createFirecrawlFetchProvider(): WebFetchProvider {
	return {
		id: "firecrawl",
		label: "Firecrawl",
		hint: "Hosted scraping API. Best fallback for JS-heavy / bot-blocked pages.",
		requiresCredential: true,
		envVars: ["FIRECRAWL_API_KEY"],
		signupUrl: "https://firecrawl.dev",
		docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
		placeholder: "fc-…",
		autoDetectOrder: 10,
		isConfigured(cfg, env) {
			return resolveFirecrawlApiKey(cfg, env) !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveFirecrawlApiKey(ctx.config, ctx.env);
			if (!apiKey) return null;
			const fetchCfg = readFirecrawlFetchConfig(ctx.config);
			const configuredTimeoutSec = fetchCfg.timeoutSeconds;
			const fallbackTimeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			const timeoutMs = typeof configuredTimeoutSec === "number" && configuredTimeoutSec > 0
				? (configuredTimeoutSec * 1_000) | 0
				: fallbackTimeoutMs;
			return {
				description: "Firecrawl scrape (markdown extraction with JS rendering).",
				parameters: {
					type: "object",
					properties: {
						url: { type: "string" },
						extractMode: { type: "string", enum: ["markdown", "text"] },
						maxChars: { type: "integer" },
					},
					required: ["url"],
				},
				async execute(args, signal) {
					const url = String((args as { url?: unknown }).url ?? "").trim();
					if (!url) throw new Error("firecrawl: missing url");

					// Build the request body with operator-configurable knobs.
					// Default `onlyMainContent: true` — best fit for one-shot model
					// consumption.
					const body: Record<string, unknown> = {
						url,
						formats: ["markdown"],
						onlyMainContent: fetchCfg.onlyMainContent ?? true,
					};
					if (fetchCfg.proxy === "auto" || fetchCfg.proxy === "basic" || fetchCfg.proxy === "stealth") {
						body.proxy = fetchCfg.proxy;
					}
					if (typeof fetchCfg.storeInCache === "boolean") {
						body.storeInCache = fetchCfg.storeInCache;
					}
					if (typeof fetchCfg.maxAgeMs === "number" && fetchCfg.maxAgeMs >= 0) {
						body.maxAge = fetchCfg.maxAgeMs;
					}
					if (typeof configuredTimeoutSec === "number" && configuredTimeoutSec > 0) {
						body.timeout = configuredTimeoutSec * 1_000;
					}

					const json = await postFirecrawl({
						endpoint: FIRECRAWL_SCRAPE_ENDPOINT,
						apiKey,
						body,
						timeoutMs,
						signal,
					});
					const data = json.data as Record<string, unknown> | undefined;
					const markdown = typeof data?.markdown === "string"
						? data.markdown
						: typeof data?.content === "string"
							? data.content
							: "";
					const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
					return {
						provider: "firecrawl",
						url,
						finalUrl: typeof metadata.sourceURL === "string" ? metadata.sourceURL : url,
						status: typeof metadata.statusCode === "number" ? metadata.statusCode : 200,
						contentType: "text/markdown",
						title: typeof metadata.title === "string" ? metadata.title : undefined,
						text: markdown,
						rawLength: markdown.length,
						extractor: "firecrawl",
					};
				},
			};
		},
	};
}

/* ─────────────────────────── search provider ─────────────────────────── */

function createFirecrawlSearchProvider(): WebSearchProvider {
	return {
		id: "firecrawl",
		label: "Firecrawl Search",
		hint: "Firecrawl's /v2/search endpoint. Same API key as Firecrawl scrape.",
		requiresCredential: true,
		envVars: ["FIRECRAWL_API_KEY"],
		signupUrl: "https://firecrawl.dev",
		docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/search",
		placeholder: "fc-…",
		// `firecrawl` keyed beats DuckDuckGo (200) but loses to the operator
		// picking a structured/paid provider explicitly.
		autoDetectOrder: 50,
		isConfigured(cfg, env) {
			return resolveFirecrawlApiKey(cfg, env) !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveFirecrawlApiKey(ctx.config, ctx.env);
			if (!apiKey) return null;
			const searchCfg = readFirecrawlSearchConfig(ctx.config);
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "Search the web via Firecrawl. Returns ranked URL hits with titles + snippets.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 25 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("firecrawl_search: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);
					const body: Record<string, unknown> = { query, limit: count };
					if (Array.isArray(searchCfg.sources) && searchCfg.sources.length > 0) {
						body.sources = searchCfg.sources;
					}
					if (Array.isArray(searchCfg.categories) && searchCfg.categories.length > 0) {
						body.categories = searchCfg.categories;
					}
					if (searchCfg.scrapeResults === true) {
						body.scrapeOptions = { formats: ["markdown"] };
					}
					const json = await postFirecrawl({
						endpoint: FIRECRAWL_SEARCH_ENDPOINT,
						apiKey,
						body,
						timeoutMs,
						signal,
					});
					const rawData = (json.data ?? json.web ?? []) as unknown;
					const hits: Array<Record<string, unknown>> = Array.isArray(rawData)
						? rawData.filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
						: [];
					// Every other web-search provider routes through
					// `wrapSearchHit` so attacker-controllable title /
					// snippet / siteName fields can't escape the untrusted-
					// content envelope. Firecrawl was the outlier — fix it.
					const results = hits
						.map((hit) => {
							const title = typeof hit.title === "string" ? hit.title.trim() : "";
							const url = typeof hit.url === "string" ? hit.url.trim() : "";
							if (!title || !url) return null;
							const rawSnippet = typeof hit.description === "string"
								? hit.description
								: typeof hit.snippet === "string"
									? hit.snippet
									: "";
							const snippet = rawSnippet.trim();
							return wrapSearchHit({
								title,
								url,
								snippet: snippet.length > 0 ? snippet : undefined,
								siteName: resolveSiteName(url),
							});
						})
						.filter((r): r is NonNullable<typeof r> => r !== null);
					return { provider: "firecrawl", results };
				},
			};
		},
	};
}

export const firecrawlModule = defineModule({
	id: "firecrawl",
	register(b: BrigadeExtensionContext) {
		b.webFetch(createFirecrawlFetchProvider());
		b.webSearch(createFirecrawlSearchProvider());
	},
});

export {
	createFirecrawlFetchProvider,
	createFirecrawlSearchProvider,
	readFirecrawlFetchConfig,
	readFirecrawlSearchConfig,
	resolveFirecrawlApiKey,
};
