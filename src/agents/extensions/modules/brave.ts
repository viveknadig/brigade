/**
 * Brave Search web-search provider — bundled, API-key-gated.
 *
 * Brave is the most reliable non-DDG fallback when the operator has an API
 * key. Endpoint: `https://api.search.brave.com/res/v1/web/search`. Auth via
 * `X-Subscription-Token`.
 *
 * Two operator-selectable modes:
 *   - `web` (default): the documented ranked-results endpoint
 *     (`/web/search`). Returns title/url/description triples + optional age.
 *   - `llm-context`: Brave's pre-extracted snippets endpoint
 *     (`/llm/context`). Useful when the agent is doing one-shot grounded
 *     RAG — Brave returns multi-snippet rows + a `sources[]` array.
 *
 * Per-call agent args (forwarded via `web_search`): query, count,
 * country, language, freshness, date_after, date_before, search_lang,
 * ui_lang. Operator config at `tools.web.search.providers.brave` can pin
 * any of the same params as defaults; per-call args override.
 *
 * Country / language / freshness / date-range inputs are validated against
 * Brave's documented sets before they hit the wire. Invalid country
 * coerces to "ALL"; invalid search_lang / ui_lang yields a typed error.
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
	mergeSignals,
	readProviderConfigSlot,
	resolveProviderApiKey,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";
import {
	normalizeFreshness,
	parseIsoDateRange,
	WEB_DOCS_URL,
} from "./web-search-filters.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";

type BraveMode = "web" | "llm-context";

interface BraveSearchConfig {
	apiKey?: string;
	mode?: BraveMode;
	country?: string;
	search_lang?: string;
	ui_lang?: string;
	freshness?: string;
	dateAfter?: string;
	dateBefore?: string;
}

interface BraveLlmContextEntry {
	url?: string;
	title?: string;
	snippets?: unknown;
}

interface BraveLlmContextResponse {
	grounding?: { generic?: BraveLlmContextEntry[] };
	sources?: Array<{ url?: string; hostname?: string; date?: string }>;
}

/**
 * Brave's documented country codes. Unknown values coerce to "ALL"
 * (Brave's wildcard) so the request still goes through with safe defaults
 * rather than 400'ing the call.
 */
const BRAVE_COUNTRY_CODES = new Set([
	"AR",
	"AU",
	"AT",
	"BE",
	"BR",
	"CA",
	"CL",
	"DK",
	"FI",
	"FR",
	"DE",
	"GR",
	"HK",
	"IN",
	"ID",
	"IT",
	"JP",
	"KR",
	"MY",
	"MX",
	"NL",
	"NZ",
	"NO",
	"CN",
	"PL",
	"PT",
	"PH",
	"RU",
	"SA",
	"ZA",
	"ES",
	"SE",
	"CH",
	"TW",
	"TR",
	"GB",
	"US",
	"ALL",
]);

const BRAVE_SEARCH_LANG_CODES = new Set([
	"ar",
	"eu",
	"bn",
	"bg",
	"ca",
	"zh-hans",
	"zh-hant",
	"hr",
	"cs",
	"da",
	"nl",
	"en",
	"en-gb",
	"et",
	"fi",
	"fr",
	"gl",
	"de",
	"el",
	"gu",
	"he",
	"hi",
	"hu",
	"is",
	"it",
	"jp",
	"kn",
	"ko",
	"lv",
	"lt",
	"ms",
	"ml",
	"mr",
	"nb",
	"pl",
	"pt-br",
	"pt-pt",
	"pa",
	"ro",
	"ru",
	"sr",
	"sk",
	"sl",
	"es",
	"sv",
	"ta",
	"te",
	"th",
	"tr",
	"uk",
	"vi",
]);

const BRAVE_SEARCH_LANG_ALIASES: Record<string, string> = {
	ja: "jp",
	zh: "zh-hans",
	"zh-cn": "zh-hans",
	"zh-hk": "zh-hant",
	"zh-sg": "zh-hans",
	"zh-tw": "zh-hant",
};

const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;
const MAX_BRAVE_SEARCH_COUNT = 25;

function normalizeBraveCountry(raw: string | undefined): string {
	if (!raw) return "ALL";
	const upper = raw.trim().toUpperCase();
	return BRAVE_COUNTRY_CODES.has(upper) ? upper : "ALL";
}

function normalizeBraveSearchLang(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const lower = raw.trim().toLowerCase();
	if (!lower) return undefined;
	const canonical = BRAVE_SEARCH_LANG_ALIASES[lower] ?? lower;
	return BRAVE_SEARCH_LANG_CODES.has(canonical) ? canonical : undefined;
}

function normalizeBraveUiLang(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const v = raw.trim();
	const match = v.match(BRAVE_UI_LANG_LOCALE);
	if (!match) return undefined;
	const language = match[1];
	const region = match[2];
	if (!language || !region) return undefined;
	return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

/**
 * Auto-swap reversed search_lang / ui_lang. The model sometimes flips
 * them (passes `search_lang: "en-US"` and `ui_lang: "en"`); if one looks
 * like the OTHER's expected shape, swap before validating. Saves the
 * agent from a "wrong field" round-trip.
 */
function normalizeBraveLanguageParams(params: {
	search_lang?: string;
	ui_lang?: string;
}): { search_lang?: string; ui_lang?: string; invalidField?: "search_lang" | "ui_lang" } {
	const rawSearchLang = params.search_lang?.trim() || undefined;
	const rawUiLang = params.ui_lang?.trim() || undefined;
	let searchLangCandidate = rawSearchLang;
	let uiLangCandidate = rawUiLang;

	if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
		searchLangCandidate = rawUiLang;
		uiLangCandidate = rawSearchLang;
	}

	const search_lang = normalizeBraveSearchLang(searchLangCandidate);
	if (searchLangCandidate && !search_lang) return { invalidField: "search_lang" };
	const ui_lang = normalizeBraveUiLang(uiLangCandidate);
	if (uiLangCandidate && !ui_lang) return { invalidField: "ui_lang" };
	return { search_lang, ui_lang };
}

interface BraveSearchHit {
	title?: string;
	url?: string;
	description?: string;
	age?: string;
}

interface BraveSearchResponse {
	web?: { results?: BraveSearchHit[] };
}

interface BraveCallArgs {
	query?: unknown;
	count?: unknown;
	country?: unknown;
	language?: unknown;
	search_lang?: unknown;
	ui_lang?: unknown;
	freshness?: unknown;
	date_after?: unknown;
	date_before?: unknown;
}

function readStringArg(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function createBraveSearchProvider(): WebSearchProvider {
	return {
		id: "brave",
		label: "Brave Search",
		hint: "Brave's web-search API. Structured JSON, no HTML scraping.",
		requiresCredential: true,
		envVars: ["BRAVE_API_KEY"],
		signupUrl: "https://brave.com/search/api/",
		docsUrl: "https://api-dashboard.search.brave.com/app/documentation",
		placeholder: "BSA…",
		autoDetectOrder: 30,
		supportsFilters: true,
		isConfigured(cfg, env) {
			return (
				resolveProviderApiKey({
					cfg,
					env,
					providerId: "brave",
					kind: "search",
					envVars: ["BRAVE_API_KEY"],
				}) !== undefined
			);
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveProviderApiKey({
				cfg: ctx.config,
				env: ctx.env,
				providerId: "brave",
				kind: "search",
				envVars: ["BRAVE_API_KEY"],
			});
			if (!apiKey) return null;
			const cfgSlot = readProviderConfigSlot<BraveSearchConfig>({
				cfg: ctx.config,
				providerId: "brave",
				kind: "search",
			});
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description:
					"Brave Search — structured JSON results with title, URL, and snippet. Supports country, language, freshness (pd/pw/pm/py), and ISO date ranges.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query string." },
						count: {
							type: "integer",
							minimum: 1,
							maximum: MAX_BRAVE_SEARCH_COUNT,
							description: "Number of results to return (1-25).",
						},
						country: {
							type: "string",
							description:
								"2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Unknown codes coerce to 'ALL'.",
						},
						language: {
							type: "string",
							description: "ISO 639-1 language code (e.g., 'en', 'de', 'fr'). Alias of search_lang.",
						},
						search_lang: {
							type: "string",
							description:
								"Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br').",
						},
						ui_lang: {
							type: "string",
							description:
								"Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE'). Must include region subtag.",
						},
						freshness: {
							type: "string",
							description:
								"Filter by recency: 'pd' (24h), 'pw' (week), 'pm' (month), 'py' (year), or a YYYY-MM-DDtoYYYY-MM-DD range.",
						},
						date_after: {
							type: "string",
							description: "Only results published on or after this date (YYYY-MM-DD).",
						},
						date_before: {
							type: "string",
							description: "Only results published on or before this date (YYYY-MM-DD).",
						},
					},
					required: ["query"],
				},
				async execute(args, signal) {
					const a = (args ?? {}) as BraveCallArgs;
					const query = String(a.query ?? "").trim();
					if (!query) throw new Error("brave: missing query");
					const count = Math.min(
						Math.max(Number(a.count ?? 10) | 0, 1),
						MAX_BRAVE_SEARCH_COUNT,
					);

					const mode: BraveMode = cfgSlot.mode === "llm-context" ? "llm-context" : "web";
					const endpoint =
						mode === "llm-context" ? BRAVE_LLM_CONTEXT_ENDPOINT : BRAVE_SEARCH_ENDPOINT;
					const url = new URL(endpoint);
					url.searchParams.set("q", query);
					if (mode === "web") url.searchParams.set("count", String(count));

					// Country: per-call > config > "ALL".
					const country = normalizeBraveCountry(
						readStringArg(a.country) ?? cfgSlot.country,
					);
					if (country) url.searchParams.set("country", country);

					// Language: prefer search_lang; fall back to `language` shorthand;
					// fall back to operator config.
					const rawSearchLang =
						readStringArg(a.search_lang) ??
						readStringArg(a.language) ??
						cfgSlot.search_lang;
					const rawUiLang = readStringArg(a.ui_lang) ?? cfgSlot.ui_lang;
					const langResult = normalizeBraveLanguageParams({
						search_lang: rawSearchLang,
						ui_lang: rawUiLang,
					});
					if (langResult.invalidField === "search_lang") {
						return {
							provider: "brave",
							error: "invalid_search_lang",
							message: `Invalid search_lang \"${rawSearchLang}\". Use a Brave language code such as 'en', 'de', 'pt-br', 'zh-hans'.`,
							docs: WEB_DOCS_URL,
						};
					}
					if (langResult.invalidField === "ui_lang") {
						return {
							provider: "brave",
							error: "invalid_ui_lang",
							message: `Invalid ui_lang \"${rawUiLang}\". Use language-region form like 'en-US' or 'de-DE'.`,
							docs: WEB_DOCS_URL,
						};
					}
					if (langResult.search_lang)
						url.searchParams.set("search_lang", langResult.search_lang);
					if (mode === "web" && langResult.ui_lang)
						url.searchParams.set("ui_lang", langResult.ui_lang);

					// Freshness OR explicit date range (mutually exclusive — freshness wins).
					if (mode === "web") {
						const rawFreshness = readStringArg(a.freshness) ?? cfgSlot.freshness;
						const freshness = normalizeFreshness(rawFreshness, "brave");
						if (rawFreshness && !freshness) {
							return {
								provider: "brave",
								error: "invalid_freshness",
								message: `Invalid freshness \"${rawFreshness}\". Use pd, pw, pm, py, or a YYYY-MM-DDtoYYYY-MM-DD range.`,
								docs: WEB_DOCS_URL,
							};
						}
						if (freshness) {
							url.searchParams.set("freshness", freshness);
						} else {
							const rawAfter = readStringArg(a.date_after) ?? cfgSlot.dateAfter;
							const rawBefore = readStringArg(a.date_before) ?? cfgSlot.dateBefore;
							const range = parseIsoDateRange({
								rawDateAfter: rawAfter,
								rawDateBefore: rawBefore,
								invalidDateAfterMessage: `Invalid date_after \"${rawAfter}\". Use YYYY-MM-DD.`,
								invalidDateBeforeMessage: `Invalid date_before \"${rawBefore}\". Use YYYY-MM-DD.`,
								invalidDateRangeMessage:
									"date_after must be on or before date_before.",
								docs: WEB_DOCS_URL,
							});
							if ("error" in range) {
								return { provider: "brave", ...range };
							}
							if (range.dateAfter && range.dateBefore) {
								url.searchParams.set(
									"freshness",
									`${range.dateAfter}to${range.dateBefore}`,
								);
							} else if (range.dateAfter) {
								const today = new Date().toISOString().slice(0, 10);
								url.searchParams.set("freshness", `${range.dateAfter}to${today}`);
							} else if (range.dateBefore) {
								url.searchParams.set("freshness", `1970-01-01to${range.dateBefore}`);
							}
						}
					}

					// Manual fetch (Brave is a trusted public endpoint — SSRF guard
					// not needed). Cache key handled upstream by web-search.ts.
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url.toString(), {
							method: "GET",
							headers: {
								accept: "application/json",
								"x-subscription-token": apiKey,
							},
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`brave: HTTP ${response.status} — ${safe}`);
						}
						if (mode === "llm-context") {
							const data = (() => {
								try {
									return JSON.parse(body) as BraveLlmContextResponse;
								} catch {
									throw new Error("brave: invalid JSON from upstream (llm-context)");
								}
							})();
							const entries = Array.isArray(data.grounding?.generic)
								? data.grounding!.generic!
								: [];
							const results = entries
								.map((entry) => {
									const title = (entry.title ?? "").trim();
									const u = (entry.url ?? "").trim();
									if (!title || !u) return null;
									const snippetList = Array.isArray(entry.snippets)
										? entry.snippets.filter(
												(s): s is string => typeof s === "string" && s.length > 0,
											)
										: [];
									const merged = snippetList.join("\n\n").trim();
									return wrapSearchHit({
										title,
										url: u,
										snippet: merged.length > 0 ? merged : undefined,
										siteName: resolveSiteName(u),
									});
								})
								.filter((h): h is NonNullable<typeof h> => h !== null);
							return {
								provider: "brave",
								mode,
								results,
								sources: data.sources,
							};
						}

						const data = (() => {
							try {
								return JSON.parse(body) as BraveSearchResponse;
							} catch {
								throw new Error("brave: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.web?.results) ? data.web!.results : [];
						const results = rawHits
							.map((hit) => {
								const title = (hit.title ?? "").trim();
								const u = (hit.url ?? "").trim();
								if (!title || !u) return null;
								return wrapSearchHit({
									title,
									url: u,
									snippet: (hit.description ?? "").trim() || undefined,
									siteName: resolveSiteName(u),
									published: hit.age,
								});
							})
							.filter((h): h is NonNullable<typeof h> => h !== null);
						return {
							provider: "brave",
							mode,
							results,
						};
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

export const braveModule = defineModule({
	id: "brave",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createBraveSearchProvider());
	},
});

export { createBraveSearchProvider };
