/**
 * Perplexity web-search provider — structured search results.
 *
 * Two transports exist in Perplexity's ecosystem: the structured Search API
 * (`/search`) and the Sonar chat-completions API (`/chat/completions` with
 * built-in citations). Brigade ships the Search API for v1 because it
 * returns clean URL hits without an extra "extract synthesized answer"
 * step. The Sonar path is a future bolt-on.
 *
 * Endpoint: `https://api.perplexity.ai/search`. Auth: `Authorization: Bearer`.
 *
 * Operator config (`tools.web.search.providers.perplexity`):
 *   { apiKey?, country?, searchRecencyFilter?, searchDomainFilter?[] }
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	readProviderConfigSlot,
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
	mergeSignals,
} from "./web-provider-helpers.js";
import {
	normalizeFreshness,
	parseIsoDateRange,
	WEB_DOCS_URL,
} from "./web-search-filters.js";

// re-import to keep helper visibility in runSonarChat below the top-level
// import block (some bundlers need this when the function is declared at
// module scope).
void resolveSiteName;

const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const PERPLEXITY_CHAT_ENDPOINT = "https://api.perplexity.ai/chat/completions";

type PerplexityTransport = "search" | "sonar";

interface PerplexityConfig {
	apiKey?: string;
	/**
	 * `search` (default): native Perplexity Search API — structured ranked
	 * hits with title/url/snippet/date. `sonar`: chat/completions API
	 * that returns an AI-synthesized answer + citations.
	 */
	transport?: PerplexityTransport;
	/** Sonar model id (only used when transport === "sonar"). */
	sonarModel?: string;
	country?: string;
	searchRecencyFilter?: "day" | "week" | "month" | "year";
	searchDomainFilter?: string[];
	/** ISO 639-1 language codes (e.g. ["en", "de"]). */
	searchLanguageFilter?: string[];
	/** YYYY-MM-DD lower-bound on publication date. */
	searchAfterDate?: string;
	/** YYYY-MM-DD upper-bound. */
	searchBeforeDate?: string;
	/** Total content budget across results (per-call). */
	maxTokens?: number;
	/** Per-page content budget. */
	maxTokensPerPage?: number;
}

function isValidIsoDate(raw: string | undefined): boolean {
	if (!raw) return false;
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`));
}

interface PerplexityHit {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	date?: unknown;
}

interface PerplexityResponse {
	results?: PerplexityHit[];
}

function createPerplexitySearchProvider(): WebSearchProvider {
	return {
		id: "perplexity",
		label: "Perplexity",
		hint: "Perplexity Search API — research-grade ranked URL hits.",
		requiresCredential: true,
		envVars: ["PERPLEXITY_API_KEY"],
		signupUrl: "https://www.perplexity.ai/settings/api",
		docsUrl: "https://docs.perplexity.ai/api-reference/search-post",
		placeholder: "pplx-…",
		autoDetectOrder: 45,
		supportsFilters: true,
		isConfigured(cfg, env) {
			return (
				resolveProviderApiKey({
					cfg,
					env,
					providerId: "perplexity",
					kind: "search",
					envVars: ["PERPLEXITY_API_KEY"],
				}) !== undefined
			);
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "perplexity",
				kind: "search",
				envVars: ["PERPLEXITY_API_KEY"],
			});
			if (!apiKey) return null;
			const cfgSlot = readProviderConfigSlot<PerplexityConfig>({
				cfg: ctx.config,
				providerId: "perplexity",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description:
					"Perplexity Search — research-mode ranked results with date metadata. Supports country, language, recency (day/week/month/year), and ISO date ranges.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 10 },
						country: {
							type: "string",
							description: "2-letter country code (e.g. 'US', 'DE').",
						},
						language: {
							type: "string",
							description: "ISO 639-1 language code (e.g., 'en', 'de').",
						},
						freshness: {
							type: "string",
							description: "Recency: 'day' / 'week' / 'month' / 'year'.",
						},
						date_after: {
							type: "string",
							description: "Only results on or after this date (YYYY-MM-DD).",
						},
						date_before: {
							type: "string",
							description: "Only results on or before this date (YYYY-MM-DD).",
						},
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const a = (args ?? {}) as Record<string, unknown>;
					const readStr = (v: unknown) =>
						typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
					const query = String(a.query ?? "").trim();
					if (!query) throw new Error("perplexity: missing query");
					const max_results = Math.min(
						Math.max(Number(a.count ?? 10) | 0, 1),
						10,
					);
					const argCountry = readStr(a.country);
					const argFreshnessRaw = readStr(a.freshness);
					const argDateAfter = readStr(a.date_after);
					const argDateBefore = readStr(a.date_before);
					const argLanguage = readStr(a.language);
					let perCallFreshness: string | undefined;
					if (argFreshnessRaw) {
						perCallFreshness = normalizeFreshness(argFreshnessRaw, "perplexity");
						if (!perCallFreshness) {
							return {
								provider: "perplexity",
								error: "invalid_freshness",
								message: `Invalid freshness \"${argFreshnessRaw}\". Use day, week, month, or year.`,
								docs: WEB_DOCS_URL,
							};
						}
					}
					let perCallAfter: string | undefined;
					let perCallBefore: string | undefined;
					if (argDateAfter || argDateBefore) {
						const range = parseIsoDateRange({
							rawDateAfter: argDateAfter,
							rawDateBefore: argDateBefore,
							invalidDateAfterMessage: `Invalid date_after \"${argDateAfter}\". Use YYYY-MM-DD.`,
							invalidDateBeforeMessage: `Invalid date_before \"${argDateBefore}\". Use YYYY-MM-DD.`,
							invalidDateRangeMessage: "date_after must be on or before date_before.",
							docs: WEB_DOCS_URL,
						});
						if ("error" in range) return { provider: "perplexity", ...range };
						perCallAfter = range.dateAfter;
						perCallBefore = range.dateBefore;
					}
					const transport: PerplexityTransport = cfgSlot.transport === "sonar" ? "sonar" : "search";
					if (transport === "sonar") {
						return await runSonarChat({
							query,
							maxResults: max_results,
							apiKey,
							cfgSlot,
							timeoutMs,
							signal,
						});
					}
					const body: Record<string, unknown> = { query, max_results };
					const effCountry = argCountry ?? cfgSlot.country;
					if (effCountry) body.country = effCountry;
					const effRecency =
						perCallFreshness ?? cfgSlot.searchRecencyFilter;
					if (effRecency) body.search_recency_filter = effRecency;
					if (cfgSlot.searchDomainFilter?.length) {
						body.search_domain_filter = cfgSlot.searchDomainFilter.slice(0, 20);
					}
					const langs: string[] = [];
					if (argLanguage && /^[a-z]{2}$/i.test(argLanguage)) langs.push(argLanguage.toLowerCase());
					if (cfgSlot.searchLanguageFilter?.length) {
						for (const l of cfgSlot.searchLanguageFilter) {
							if (/^[a-z]{2}$/i.test(l)) {
								const lower = l.toLowerCase();
								if (!langs.includes(lower)) langs.push(lower);
							}
						}
					}
					if (langs.length) body.search_language_filter = langs;
					const effAfter = perCallAfter ?? cfgSlot.searchAfterDate;
					const effBefore = perCallBefore ?? cfgSlot.searchBeforeDate;
					if (effAfter && isValidIsoDate(effAfter)) body.search_after_date = effAfter;
					if (effBefore && isValidIsoDate(effBefore)) body.search_before_date = effBefore;
					if (typeof cfgSlot.maxTokens === "number" && cfgSlot.maxTokens > 0) {
						body.max_tokens = cfgSlot.maxTokens | 0;
					}
					if (typeof cfgSlot.maxTokensPerPage === "number" && cfgSlot.maxTokensPerPage > 0) {
						body.max_tokens_per_page = cfgSlot.maxTokensPerPage | 0;
					}

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(PERPLEXITY_SEARCH_ENDPOINT, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
								// Telemetry hints — Perplexity uses these to bucket
								// usage for OpenRouter-routed flows + ranking.
								"http-referer": "https://github.com/Bhasvanth-Dev9380/brigade",
								"x-title": "Brigade",
							},
							body: JSON.stringify(body),
							signal: combined,
						});
						const { text: rawBody } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`perplexity: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(rawBody) as PerplexityResponse;
							} catch {
								throw new Error("perplexity: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.map((h) => {
								const title = typeof h.title === "string" ? h.title.trim() : "";
								const url = typeof h.url === "string" ? h.url.trim() : "";
								if (!title || !url) return null;
								return wrapSearchHit({
									title,
									url,
									snippet: typeof h.snippet === "string" ? h.snippet.trim() : undefined,
									siteName: resolveSiteName(url),
									published: typeof h.date === "string" ? h.date : undefined,
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "perplexity", results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

/**
 * Run a Perplexity Sonar chat completion. Treats the question as a single
 * user turn and asks the model to answer with citations. Returns the
 * answer (envelope-wrapped) plus a flattened `citations[]` derived from
 * BOTH the top-level `citations` array AND `choices[].message.annotations`
 * (Perplexity emits citations in both spots depending on model version).
 */
async function runSonarChat(params: {
	query: string;
	maxResults: number;
	apiKey: string;
	cfgSlot: Partial<PerplexityConfig>;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
	const { query, maxResults, apiKey, cfgSlot, timeoutMs } = params;
	const model = cfgSlot.sonarModel?.trim() || "sonar";
	const body: Record<string, unknown> = {
		model,
		messages: [
			{
				role: "system",
				content:
					"You are a research assistant. Answer the user's question concisely, citing each claim with the source URL. Return only the answer text.",
			},
			{ role: "user", content: query },
		],
	};
	if (cfgSlot.searchRecencyFilter) body.search_recency_filter = cfgSlot.searchRecencyFilter;
	if (cfgSlot.searchDomainFilter?.length) {
		body.search_domain_filter = cfgSlot.searchDomainFilter.slice(0, 20);
	}
	if (cfgSlot.country) body.country = cfgSlot.country;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	timer.unref?.();
	const combined = mergeSignals([params.signal, controller.signal]);
	try {
		const response = await fetch(PERPLEXITY_CHAT_ENDPOINT, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
				"http-referer": "https://github.com/Bhasvanth-Dev9380/brigade",
				"x-title": "Brigade",
			},
			body: JSON.stringify(body),
			signal: combined,
		});
		const { text: rawBody } = await readResponseText(response.body, 2_000_000);
		if (response.status !== 200) {
			const safe = rawBody.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
			throw new Error(`perplexity sonar: HTTP ${response.status} — ${safe}`);
		}
		const data = (() => {
			try {
				return JSON.parse(rawBody) as Record<string, unknown>;
			} catch {
				throw new Error("perplexity sonar: invalid JSON from upstream");
			}
		})();
		const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
		const message = choices[0]?.message as Record<string, unknown> | undefined;
		const answerText = typeof message?.content === "string" ? message.content.trim() : "";

		// Citations come from EITHER the top-level `citations[]` (Perplexity
		// classic shape) OR `choices[0].message.annotations[]` with type
		// `url_citation`. Merge both, dedupe by URL, cap at maxResults.
		const citations = new Set<string>();
		const topCites = Array.isArray(data.citations) ? data.citations : [];
		for (const c of topCites) {
			if (typeof c === "string" && c.trim()) citations.add(c.trim());
		}
		const annotations = Array.isArray(message?.annotations)
			? (message!.annotations as Array<Record<string, unknown>>)
			: [];
		for (const ann of annotations) {
			if (ann?.type === "url_citation") {
				const inner = ann.url_citation as Record<string, unknown> | undefined;
				const candidate = typeof ann.url === "string"
					? ann.url
					: typeof inner?.url === "string"
						? inner.url
						: "";
				if (candidate) citations.add(candidate);
			}
		}
		const citationList = Array.from(citations).slice(0, maxResults);

		// Sonar doesn't return per-hit titles; surface the citation URLs as
		// minimal result rows so the schema matches the search transport.
		// Title falls back to hostname; snippet wraps the URL itself.
		const results = citationList
			.map((u) => {
				try {
					const host = new URL(u).hostname;
					return wrapSearchHit({ title: host, url: u, siteName: host });
				} catch {
					return null;
				}
			})
			.filter((h): h is NonNullable<typeof h> => h !== null);

		return {
			provider: "perplexity",
			mode: "sonar",
			results,
			answer: answerText, // gets wrapped downstream by web-search.ts normalizer
			citations: citationList,
		};
	} finally {
		clearTimeout(timer);
	}
}

export const perplexityModule = defineModule({
	id: "perplexity",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createPerplexitySearchProvider());
	},
});

export { createPerplexitySearchProvider };
