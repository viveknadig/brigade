/**
 * SearXNG web-search provider — keyless, self-hosted metasearch.
 *
 * SearXNG aggregates dozens of search engines on a single instance the
 * operator runs themselves. Brigade pings the configured `baseUrl/search`
 * with `format=json`. No API key needed — the credential here is the URL.
 *
 * Why ship a self-hosted option: when all paid providers are quota-exhausted
 * or down, a private SearXNG instance keeps `web_search` working. Privacy-
 * conscious operators also prefer it.
 *
 * Operator config (`tools.web.search.providers.searxng`):
 *   { baseUrl?, categories?, language? }
 *
 * baseUrl defaults to env `SEARXNG_BASE_URL` if config-side is unset.
 *
 * SSRF posture: an http:// baseUrl must point at a private/loopback host —
 * `assertHttpUrlTargetsPrivateNetwork` is checked at runtime. https:// is
 * allowed for any host (operator's responsibility).
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
} from "../types.js";
import { classifyHostnameSync } from "../../../infra/net/fetch-guard.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";
import {
	readProviderConfigSlot,
	resolveSiteName,
	wrapSearchHit,
} from "./web-provider-helpers.js";

interface SearxngConfig {
	baseUrl?: string;
	categories?: string;
	language?: string;
}

function resolveSearxngBaseUrl(cfgSlot: Partial<SearxngConfig>, env?: NodeJS.ProcessEnv): string | undefined {
	const cfg = cfgSlot.baseUrl?.trim();
	if (cfg) return cfg.replace(/\/$/, "");
	const envValue = env?.SEARXNG_BASE_URL?.trim();
	return envValue ? envValue.replace(/\/$/, "") : undefined;
}

/**
 * Validate the configured base URL — refuse non-http(s), refuse plain `http://`
 * pointed at a public host (would be unencrypted credentials over the open
 * net), allow private/loopback for http://, allow any host for https://.
 */
function validateSearxngBaseUrl(baseUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error("SearXNG base URL must be a valid http(s) URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("SearXNG base URL must use http:// or https://.");
	}
	if (parsed.protocol === "http:") {
		const reason = classifyHostnameSync(parsed.hostname);
		// `classifyHostnameSync` returns a string when the host is on the
		// SSRF refuse-list. For SearXNG specifically that's GOOD — http://
		// targeting a private host is exactly the safe configuration.
		if (!reason) {
			throw new Error(
				"SearXNG plain-http base URL must point at a private / loopback host. Use https:// for public instances.",
			);
		}
	}
}

function buildSearxngUrl(args: {
	baseUrl: string;
	query: string;
	categories?: string;
	language?: string;
}): string {
	const url = new URL(args.baseUrl);
	const pathname = url.pathname.endsWith("/") ? `${url.pathname}search` : `${url.pathname}/search`;
	url.pathname = pathname;
	url.search = "";
	url.searchParams.set("q", args.query);
	url.searchParams.set("format", "json");
	if (args.categories) url.searchParams.set("categories", args.categories);
	if (args.language) url.searchParams.set("language", args.language);
	return url.toString();
}

interface SearxngHit {
	url?: unknown;
	title?: unknown;
	content?: unknown;
}

interface SearxngResponse {
	results?: SearxngHit[];
}

function createSearxngSearchProvider(): WebSearchProvider {
	return {
		id: "searxng",
		label: "SearXNG",
		hint: "Self-hosted metasearch. Operator provides the instance URL.",
		// requiresCredential: true — the "credential" is the URL, not a key.
		requiresCredential: true,
		envVars: ["SEARXNG_BASE_URL"],
		signupUrl: "https://docs.searxng.org/admin/installation.html",
		docsUrl: "https://docs.searxng.org/",
		placeholder: "http://localhost:8888",
		// Lowest priority — picked only when nothing better is configured.
		// (Equal to DuckDuckGo at 200; DDG ships keyless so it usually wins.)
		autoDetectOrder: 180,
		isConfigured(cfg, env) {
			const cfgSlot = readProviderConfigSlot<SearxngConfig>({
				cfg,
				providerId: "searxng",
				kind: "search",
			});
			return resolveSearxngBaseUrl(cfgSlot, env) !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const cfgSlot = readProviderConfigSlot<SearxngConfig>({
				cfg: ctx.config,
				providerId: "searxng",
				kind: "search",
			});
			const baseUrl = resolveSearxngBaseUrl(cfgSlot, ctx.env);
			if (!baseUrl) return null;
			try {
				validateSearxngBaseUrl(baseUrl);
			} catch {
				// Operator misconfiguration — surface as a tool error at execute
				// time, not at registration (so the error includes the URL the
				// model attempted to use).
			}
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
			return {
				description: "SearXNG self-hosted metasearch — keyless, privacy-first.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string" },
						count: { type: "integer", minimum: 1, maximum: 25 },
					},
					required: ["query"],
				},
				async execute(args, signal) {
					validateSearxngBaseUrl(baseUrl);
					const query = String((args as { query?: unknown }).query ?? "").trim();
					if (!query) throw new Error("searxng: missing query");
					const count = Math.min(
						Math.max(Number((args as { count?: unknown }).count ?? 10) | 0, 1),
						25,
					);

					const url = buildSearxngUrl({
						baseUrl,
						query,
						categories: cfgSlot.categories,
						language: cfgSlot.language,
					});

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(url, {
							method: "GET",
							headers: { accept: "application/json" },
							signal: combined,
						});
						const { text: body, truncated } = await readResponseText(response.body, 1_000_000);
						if (truncated) throw new Error("searxng: response too large");
						if (response.status !== 200) {
							const safe = body.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
							throw new Error(`searxng: HTTP ${response.status} — ${safe}`);
						}
						const data = (() => {
							try {
								return JSON.parse(body) as SearxngResponse;
							} catch {
								throw new Error("searxng: invalid JSON from upstream");
							}
						})();
						const rawHits = Array.isArray(data.results) ? data.results : [];
						const results = rawHits
							.slice(0, count)
							.map((h) => {
								const title = typeof h.title === "string" ? h.title.trim() : "";
								const u = typeof h.url === "string" ? h.url.trim() : "";
								if (!title || !u) return null;
								return wrapSearchHit({
									title,
									url: u,
									snippet: typeof h.content === "string" ? h.content.trim() : undefined,
									siteName: resolveSiteName(u),
								});
							})
							.filter((r): r is NonNullable<typeof r> => r !== null);
						return { provider: "searxng", results };
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

function mergeSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
	const real = signals.filter((s): s is AbortSignal => s !== undefined);
	if (real.length === 0) return undefined;
	if (real.length === 1) return real[0];
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn.call(AbortSignal, real);
	const ctl = new AbortController();
	for (const s of real) {
		if (s.aborted) {
			ctl.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
	}
	return ctl.signal;
}

export const searxngModule = defineModule({
	id: "searxng",
	register(b: BrigadeExtensionContext) {
		b.webSearch(createSearxngSearchProvider());
	},
});

export { buildSearxngUrl, createSearxngSearchProvider, resolveSearxngBaseUrl, validateSearxngBaseUrl };
