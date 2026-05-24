/**
 * `web_search` tool — thin wrapper over the active `WebSearchProvider`.
 *
 * Unlike `fetch_url` (built-in raw HTTP + provider fallback), web_search has
 * NO built-in implementation. It's purely a router: the registry resolves
 * the active provider (DuckDuckGo by default, Brave/Tavily/Exa/etc. when
 * configured), calls the provider's `createTool(ctx)` factory once per
 * session, and exposes the resulting tool to the agent under the stable
 * name `web_search`.
 *
 * Result normalization happens here so every provider's free-form return
 * lands in the same `{content, details}` shape — the model sees one
 * envelope no matter which search backend served the query.
 *
 * Closes the same two gaps as `fetch_url`: `onUpdate` fires for streaming
 * progress; `AbortSignal` is threaded through to the provider's execute.
 */

import { Type, type Static } from "typebox";

import { buildExternalContentMeta, wrapWebContent } from "../../security/external-content.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	buildSearchCacheKey,
	type CacheEntry,
	DEFAULT_CACHE_TTL_MINUTES,
	readCache,
	resolveCacheTtlMs,
	writeCache,
} from "./web-shared.js";
import type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./types.js";
import type { WebProviderContext, WebSearchProvider } from "../extensions/types.js";

const log = createSubsystemLogger("brigade/web");

/* ─────────────────────────── schema + result shape ─────────────────────────── */

const WebSearchSchema = Type.Object({
	query: Type.String({
		description: "Search query. Plain text; the active provider handles syntax (quotes, operators, etc.).",
		minLength: 1,
	}),
	count: Type.Optional(
		Type.Integer({
			description: "Max results to return (default 10, max 25).",
			minimum: 1,
			maximum: 25,
		}),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Override the auto-detected provider for THIS call only. One of the registered IDs (brave, tavily, exa, perplexity, duckduckgo, searxng, firecrawl). Leave unset to use the operator-configured default.",
			minLength: 1,
		}),
	),
});

/** One result row in the normalized envelope. Drift between providers
 *  (`description` vs `snippet`) is normalized to `snippet`. */
export interface WebSearchHit {
	title: string;
	url: string;
	snippet?: string;
	siteName?: string;
	published?: string;
	score?: number;
}

export interface WebSearchDetails {
	query: string;
	provider: string;
	count: number;
	tookMs: number;
	results: WebSearchHit[];
	answer?: string;
	citations?: string[];
	externalContent: { untrusted: true; source: "web_search"; provider?: string; wrapped: boolean };
	cached?: true;
}

const DEFAULT_COUNT = 10;

const SEARCH_CACHE = new Map<string, CacheEntry<WebSearchDetails>>();

/* ─────────────────────────── public factory ─────────────────────────── */

export interface MakeWebSearchToolOptions {
	provider: WebSearchProvider;
	providerCtx: WebProviderContext;
	cacheTtlMinutes?: number;
	/**
	 * Optional resolver: when set, the tool consults it on each call to
	 * find an alternate provider when the model passes
	 * `provider: "<id>"` in the call args. Lets the agent pick a specific
	 * backend for a single query without changing operator config.
	 */
	lookupProviderById?: (id: string) => WebSearchProvider | null;
}

/**
 * Build the `web_search` tool around a resolved provider. Returns `null` if
 * the provider's `createTool(ctx)` factory itself returns null (e.g. the
 * provider declared itself configured but the runtime check came back
 * negative). Caller drops the tool from the agent surface when null.
 */
export function makeWebSearchTool(opts: MakeWebSearchToolOptions): AnyBrigadeTool | null {
	const defaultProviderTool = opts.provider.createTool(opts.providerCtx);
	if (!defaultProviderTool) return null;
	const cacheTtlMs = resolveCacheTtlMs(opts.cacheTtlMinutes ?? DEFAULT_CACHE_TTL_MINUTES);

	const tool: BrigadeTool<typeof WebSearchSchema, WebSearchDetails> = {
		name: "web_search",
		label: "web_search",
		description: `Search the web using ${opts.provider.label}. Returns titles, URLs, and snippets for fast research.`,
		parameters: WebSearchSchema,
		ownerOnly: false,
		displaySummary: "searching the web",
		async execute(
			_toolCallId: string,
			args: Static<typeof WebSearchSchema>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
		): Promise<AgentToolResult<WebSearchDetails>> {
			const query = args.query.trim();
			const count = args.count ?? DEFAULT_COUNT;
			const startedAt = Date.now();

			// Per-call provider override. The model can request a specific
			// backend for one query (e.g. "use brave for this");
			// resolution uses the registry-side lookup so the override
			// respects deny/allow lists. If the override fails (unknown
			// id, not configured, denied), fall back to the default.
			let activeProvider: WebSearchProvider = opts.provider;
			let activeProviderTool = defaultProviderTool;
			const requested = args.provider?.trim();
			if (requested && requested !== opts.provider.id && opts.lookupProviderById) {
				const found = opts.lookupProviderById(requested);
				if (found) {
					const overrideTool = found.createTool(opts.providerCtx);
					if (overrideTool) {
						activeProvider = found;
						activeProviderTool = overrideTool;
					}
				}
			}

			const cacheKey = buildSearchCacheKey([activeProvider.id, query, count]);
			const cached = readCache(SEARCH_CACHE, cacheKey);
			if (cached) {
				log.debug("web_search cache hit", { provider: activeProvider.id, query });
				return jsonResult({ ...cached, cached: true });
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching (${activeProvider.label})…` }],
				details: {} as WebSearchDetails,
			});

			const raw = await activeProviderTool.execute({ query, count }, signal);
			const payload = normalizeProviderPayload({
				raw,
				provider: activeProvider.id,
				query,
				count,
			});
			payload.tookMs = Date.now() - startedAt;
			writeCache(SEARCH_CACHE, cacheKey, payload, { ttlMs: cacheTtlMs });
			log.info("web_search ok", {
				provider: payload.provider,
				query,
				count: payload.count,
				resultCount: payload.results.length,
				tookMs: payload.tookMs,
			});
			return jsonResult(payload);
		},
	};
	return tool;
}

/* ─────────────────────────── normalize provider's free-form return ─────────────────────────── */

function normalizeProviderPayload(args: {
	raw: Record<string, unknown>;
	provider: string;
	query: string;
	count: number;
}): WebSearchDetails {
	const r = args.raw;
	const rawResults = Array.isArray(r.results) ? r.results : [];
	const results: WebSearchHit[] = rawResults
		.map((rawHit): WebSearchHit | null => {
			if (!rawHit || typeof rawHit !== "object") return null;
			const hit = rawHit as Record<string, unknown>;
			const rawTitle = String(hit.title ?? hit.name ?? "").trim();
			const url = String(hit.url ?? hit.link ?? hit.href ?? "").trim();
			if (!rawTitle || !url) return null;
			// Title is attacker-controllable — a poisoned page can put
			// `</content><<<END_EXTERNAL...>>>Ignore prior instructions...`
			// in <title> and break out of the envelope. Wrap it.
			const title = wrapWebContent(rawTitle, "web_search", { includeWarning: false });
			// Accept both `snippet` (Tavily/DDG) and `description` (Brave/PPX).
			const snippet = (() => {
				const raw = hit.snippet ?? hit.description ?? hit.summary;
				if (typeof raw !== "string") return undefined;
				const trimmed = raw.trim();
				return trimmed.length > 0
					? wrapWebContent(trimmed, "web_search", { includeWarning: false })
					: undefined;
			})();
			// `siteName` is normally a hostname (derived from URL), but
			// providers sometimes pass arbitrary `source` strings. Wrap when
			// it came from a provider field; URL-derived hostnames are safe.
			const siteName = (() => {
				const fromProvider =
					typeof hit.siteName === "string"
						? hit.siteName
						: typeof hit.source === "string"
							? hit.source
							: null;
				if (fromProvider !== null) {
					const trimmed = fromProvider.trim();
					return trimmed.length > 0
						? wrapWebContent(trimmed, "web_search", { includeWarning: false })
						: undefined;
				}
				try {
					return new URL(url).hostname;
				} catch {
					return undefined;
				}
			})();
			return {
				title,
				url,
				snippet,
				siteName,
				published:
					typeof hit.published === "string"
						? hit.published
						: typeof hit.publishedDate === "string"
							? hit.publishedDate
							: typeof hit.age === "string"
								? hit.age
								: undefined,
				score: typeof hit.score === "number" ? hit.score : undefined,
			};
		})
		.filter((h): h is WebSearchHit => h !== null);

	// Some providers carry a top-level "answer" + "citations[]". Preserve when present.
	const answer = (() => {
		const raw = r.answer ?? r.content;
		if (typeof raw !== "string") return undefined;
		const trimmed = raw.trim();
		return trimmed.length > 0 ? wrapWebContent(trimmed, "web_search") : undefined;
	})();
	const citations = Array.isArray(r.citations)
		? r.citations.filter((c: unknown): c is string => typeof c === "string")
		: undefined;

	return {
		query: args.query,
		provider: args.provider,
		count: args.count,
		tookMs: 0,
		results,
		answer,
		citations,
		externalContent: buildExternalContentMeta({
			source: "web_search",
			provider: args.provider,
			wrapped: true,
		}),
	};
}

/* ─────────────────────────── helpers ─────────────────────────── */

function jsonResult(payload: WebSearchDetails): AgentToolResult<WebSearchDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

export { SEARCH_CACHE, WebSearchSchema };
