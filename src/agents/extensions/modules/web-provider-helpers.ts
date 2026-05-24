/**
 * Shared helpers for web-search/fetch provider modules.
 *
 * Every bundled web provider (Brave, Tavily, Exa, Perplexity, SearXNG,
 * Firecrawl) repeats the same boilerplate: resolve an API key from
 * `tools.web.<kind>.providers.<id>.apiKey` then fall back to an env var,
 * wrap results in the untrusted-content envelope, build a stable cache key
 * over the query + filters. Put it here once so each provider file stays
 * lean and the patterns can't drift apart.
 */

import { wrapWebContent } from "../../../security/external-content.js";
import type { BrigadeConfig } from "../../../config/io.js";

/**
 * Strip CR/LF/NUL/non-printable bytes from anything we put in an HTTP
 * header — guards against header injection via a poisoned token. Single
 * source of truth; every provider that sets `Authorization` or similar
 * MUST route raw key material through this before concatenation.
 */
export function sanitizeHeaderToken(raw: string): string {
	return raw.replace(/[\r\n\0\t\v\f]/g, "").replace(/[^\x20-\x7e]/g, "");
}

/**
 * Merge multiple `AbortSignal`s into one that aborts when ANY input
 * aborts. Returns `undefined` when all inputs are undefined (no signal).
 *
 * Single source of truth for the keyless providers + the SSRF guard —
 * previously copy-pasted into 12 modules, which made bug-fixing a
 * minefield. Use `AbortSignal.any()` when the runtime supports it
 * (Node 22+), fall back to manual wiring otherwise.
 */
export function mergeSignals(
	signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
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

/**
 * Resolve a provider API key from either operator config or env. Lookup
 * order is config first, then env — the operator pins config to override.
 * Returns the sanitized key or undefined if neither source has a usable
 * value. Pass `searchKind = "fetch" | "search"` so the right config slot
 * is read for split-purpose providers (Firecrawl, Tavily).
 */
export function resolveProviderApiKey(args: {
	cfg: BrigadeConfig;
	env?: NodeJS.ProcessEnv;
	providerId: string;
	kind: "fetch" | "search";
	envVars: ReadonlyArray<string>;
}): string | undefined {
	const slot = (
		args.cfg as {
			tools?: {
				web?: {
					fetch?: { providers?: Record<string, { apiKey?: string }> };
					search?: { providers?: Record<string, { apiKey?: string }> };
				};
			};
		}
	).tools?.web?.[args.kind]?.providers?.[args.providerId];
	const cfgKey = typeof slot?.apiKey === "string" ? slot.apiKey.trim() : "";
	let raw = cfgKey;
	if (!raw) {
		for (const varName of args.envVars) {
			const v = args.env?.[varName]?.trim();
			if (v) {
				raw = v;
				break;
			}
		}
	}
	if (!raw) return undefined;
	const cleaned = sanitizeHeaderToken(raw);
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Read a typed provider-scoped config slot. Returns whatever the operator
 * put under `tools.web.<kind>.providers.<id>` (or empty when absent).
 */
export function readProviderConfigSlot<T extends object = Record<string, unknown>>(args: {
	cfg: BrigadeConfig;
	providerId: string;
	kind: "fetch" | "search";
}): Partial<T> {
	const slot = (
		args.cfg as {
			tools?: {
				web?: {
					fetch?: { providers?: Record<string, unknown> };
					search?: { providers?: Record<string, unknown> };
				};
			};
		}
	).tools?.web?.[args.kind]?.providers?.[args.providerId];
	return (slot ?? {}) as Partial<T>;
}

/** Derive a hostname from a URL for `siteName` — best-effort, undefined on bad URL. */
export function resolveSiteName(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Normalize a freshness preset. Returns the canonical brave/tavily-friendly
 * single character ("d"/"w"/"m"/"y") OR the original token if it's already
 * a long form ("day"/"week"/"month"/"year"). Returns undefined on garbage.
 */
export function normalizeFreshnessPreset(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const v = raw.trim().toLowerCase();
	if (!v) return undefined;
	const allowed = new Set(["d", "w", "m", "y", "day", "week", "month", "year"]);
	return allowed.has(v) ? v : undefined;
}

/** Validate a YYYY-MM-DD date literal; returns the trimmed value or undefined. */
export function parseIsoDate(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const v = raw.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
	const t = Date.parse(`${v}T00:00:00Z`);
	return Number.isFinite(t) ? v : undefined;
}

/**
 * Build a stable cache key from JSON-serialisable parts. Lowercased + trimmed
 * matches the shared `normalizeCacheKey` semantics so different providers'
 * keys remain comparable.
 */
export function makeProviderCacheKey(parts: unknown[]): string {
	return JSON.stringify(parts).trim().toLowerCase();
}

/**
 * Wrap a raw result row's free-text fields. Snippet + title go through the
 * envelope so poisoned page content can't escape the wrapper. URL stays
 * unwrapped (deserialized as data, not text). Skip envelope warning per
 * call because the parent `web_search` result already carries one.
 */
export function wrapSearchHit(args: {
	title: string;
	url: string;
	snippet?: string;
	siteName?: string;
	published?: string;
	score?: number;
}): {
	title: string;
	url: string;
	snippet?: string;
	siteName?: string;
	published?: string;
	score?: number;
} {
	const wrappedTitle = wrapWebContent(args.title, "web_search", { includeWarning: false });
	const wrappedSnippet = args.snippet
		? wrapWebContent(args.snippet, "web_search", { includeWarning: false })
		: undefined;
	const wrappedSiteName = args.siteName
		? wrapWebContent(args.siteName, "web_search", { includeWarning: false })
		: undefined;
	return {
		title: wrappedTitle,
		url: args.url,
		snippet: wrappedSnippet,
		siteName: wrappedSiteName,
		published: args.published,
		score: args.score,
	};
}
