/**
 * Account-id canonicalisation for multi-account channels.
 *
 * Brand-scrubbed lift of the upstream reference codebase's
 * `src/routing/account-id.ts`. Every line preserved except identifier
 * paths (`../infra/prototype-keys.js`, `../shared/string-coerce.js`)
 * which resolve to Brigade's equivalents.
 *
 * Purpose: every consumer of `accountId` — channel-manager fan-out,
 * session-key builder, route resolver, approval-router pending map —
 * normalises through this module so:
 *
 *   1. Two accounts that differ only in casing / whitespace
 *      ("WhatsApp-Personal" vs "whatsapp-personal") collapse to ONE
 *      canonical id and share the same session.
 *   2. Filesystem-unsafe characters (`..`, `/`, `\`, NUL, etc.) get
 *      replaced with `-` BEFORE the id ever lands in a path component,
 *      a session-key suffix, or a JSON map key.
 *   3. Prototype-pollution keys (`__proto__`, `prototype`, `constructor`)
 *      are refused — the call returns `DEFAULT_ACCOUNT_ID` ("default")
 *      so the runtime never `Map.set("__proto__", ...)` a state object.
 *   4. Empty / missing input collapses to `DEFAULT_ACCOUNT_ID` so
 *      single-account legacy configs work without ever specifying a
 *      string.
 *
 * Cache: per-input-string LRU (max 512 entries) on each of the two
 * public entry points. Inputs are pre-trimmed before the cache lookup
 * so `"acct"` and `"  acct  "` hit the same cached canonical value.
 */

import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

export const DEFAULT_ACCOUNT_ID = "default";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;

const normalizeAccountIdCache = new Map<string, string>();
const normalizeOptionalAccountIdCache = new Map<string, string | undefined>();

function canonicalizeAccountId(value: string): string {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (VALID_ID_RE.test(value)) {
		return normalized;
	}
	return normalized
		.replace(INVALID_CHARS_RE, "-")
		.replace(LEADING_DASH_RE, "")
		.replace(TRAILING_DASH_RE, "")
		.slice(0, 64);
}

function normalizeCanonicalAccountId(value: string): string | undefined {
	const canonical = canonicalizeAccountId(value);
	if (!canonical || isBlockedObjectKey(canonical)) {
		return undefined;
	}
	return canonical;
}

/**
 * Canonical accountId for a value. Missing / empty / unrecoverable input
 * collapses to {@link DEFAULT_ACCOUNT_ID} so callers never have to
 * null-guard. The 90%-of-call-sites entry point.
 */
export function normalizeAccountId(value: string | undefined | null): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		return DEFAULT_ACCOUNT_ID;
	}
	const cached = normalizeAccountIdCache.get(trimmed);
	if (cached) {
		return cached;
	}
	const normalized = normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
	setNormalizeCache(normalizeAccountIdCache, trimmed, normalized);
	return normalized;
}

/**
 * Variant that returns `undefined` for missing input instead of the
 * default fallback. Used by routing tier predicates that want to
 * distinguish "no account constraint specified" from "default account".
 */
export function normalizeOptionalAccountId(value: string | undefined | null): string | undefined {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		return undefined;
	}
	if (normalizeOptionalAccountIdCache.has(trimmed)) {
		return normalizeOptionalAccountIdCache.get(trimmed);
	}
	const normalized = normalizeCanonicalAccountId(trimmed) || undefined;
	setNormalizeCache(normalizeOptionalAccountIdCache, trimmed, normalized);
	return normalized;
}

function setNormalizeCache<T>(cache: Map<string, T>, key: string, value: T): void {
	cache.set(key, value);
	if (cache.size <= ACCOUNT_ID_CACHE_MAX) {
		return;
	}
	const oldest = cache.keys().next();
	if (!oldest.done) {
		cache.delete(oldest.value);
	}
}
