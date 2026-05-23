/**
 * Firecrawl web-fetch provider — bundled, API-key-gated.
 *
 * Falls back from the built-in raw HTTP fetcher when:
 *   - the page is JS-heavy (built-in returns empty / shell HTML)
 *   - the upstream blocks Node's default User-Agent
 *   - the built-in throws a network error
 *
 * Hits `https://api.firecrawl.dev/v2/scrape` with the configured API key,
 * asks for `markdown` format, and returns the markdown + metadata.
 *
 * Operator config: set `FIRECRAWL_API_KEY` env OR `tools.web.fetch.providers.firecrawl.apiKey`
 * in `brigade.json`. Sign-up at https://firecrawl.dev (free tier ~500 pages/mo).
 */

import { defineModule } from "../types.js";
import type {
	BrigadeExtensionContext,
	WebFetchProvider,
	WebProviderContext,
	WebProviderToolDefinition,
} from "../types.js";
import type { BrigadeConfig } from "../../../config/io.js";
import { DEFAULT_TIMEOUT_SECONDS, readResponseText } from "../../tools/web-shared.js";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

/**
 * Strip any character that would let an attacker break out of an HTTP
 * header. CR/LF/NUL inside a Bearer token can forge new headers
 * (response/request splitting). Also rejects characters outside the
 * printable ASCII range that HTTP headers permit.
 */
function sanitizeHeaderToken(raw: string): string {
	return raw.replace(/[\r\n\0\t\v\f]/g, "").replace(/[^\x20-\x7e]/g, "");
}

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

/** Build the Firecrawl provider. Activates when `FIRECRAWL_API_KEY` is present. */
function createFirecrawlProvider(): WebFetchProvider {
	return {
		id: "firecrawl",
		label: "Firecrawl",
		hint: "Hosted scraping API. Best fallback for JS-heavy / bot-blocked pages.",
		requiresCredential: true,
		envVars: ["FIRECRAWL_API_KEY"],
		signupUrl: "https://firecrawl.dev",
		docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
		placeholder: "fc-…",
		autoDetectOrder: 10, // wins over built-in raw on fallback when configured
		isConfigured(cfg, env) {
			return resolveFirecrawlApiKey(cfg, env) !== undefined;
		},
		createTool(ctx: WebProviderContext): WebProviderToolDefinition | null {
			const apiKey = resolveFirecrawlApiKey(ctx.config, ctx.env);
			if (!apiKey) return null;
			const timeoutMs = (ctx.runtime?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000) | 0;
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

					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
					timer.unref?.();
					const combined = mergeSignals([signal, controller.signal]);
					try {
						const response = await fetch(FIRECRAWL_ENDPOINT, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
							},
							body: JSON.stringify({
								url,
								formats: ["markdown"],
								onlyMainContent: true,
							}),
							signal: combined,
						});
						const { text: body } = await readResponseText(response.body, 2_000_000);
						if (response.status !== 200) {
							// Strip control chars and cap before surfacing — the upstream body
							// is attacker-influenceable text and lands in a thrown Error.message.
							const safeSnippet = body
								.replace(/[\x00-\x1f\x7f]/g, " ")
								.slice(0, 200);
							throw new Error(`firecrawl: HTTP ${response.status} — ${safeSnippet}`);
						}
						const json = (() => {
							try {
								return JSON.parse(body) as Record<string, unknown>;
							} catch {
								return null;
							}
						})();
						if (!json || json.success === false) {
							const errMsg =
								typeof (json as { error?: unknown } | null)?.error === "string"
									? (json as { error: string }).error
									: "firecrawl returned no success payload";
							throw new Error(`firecrawl: ${errMsg}`);
						}
						const data = json.data as Record<string, unknown> | undefined;
						const markdown =
							typeof data?.markdown === "string"
								? data.markdown
								: typeof data?.content === "string"
									? data.content
									: "";
						const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
						return {
							provider: "firecrawl",
							url,
							finalUrl:
								typeof metadata.sourceURL === "string" ? (metadata.sourceURL as string) : url,
							status: 200,
							contentType: "text/markdown",
							title: typeof metadata.title === "string" ? (metadata.title as string) : undefined,
							text: markdown,
							rawLength: markdown.length,
							extractor: "firecrawl",
						};
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
	};
}

/** Merge multiple `AbortSignal`s into one that aborts when ANY input aborts. */
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

export const firecrawlModule = defineModule({
	id: "firecrawl",
	register(b: BrigadeExtensionContext) {
		b.webFetch(createFirecrawlProvider());
	},
});

export { createFirecrawlProvider, resolveFirecrawlApiKey };
