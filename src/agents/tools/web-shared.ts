/**
 * Shared primitives for web tools — cache, body reader, key normalization.
 *
 * Lifted in shape from the upstream reference: a per-process LRU `Map` cache
 * (15-min TTL, 100-entry FIFO eviction), a streaming `readResponseText` that
 * truncates at a max-byte cap instead of buffering-then-slicing, and
 * `normalizeCacheKey` (lowercase + trim) so trivial casing differences hit
 * the same entry.
 *
 * Pure-ish: cache state lives in the caller's `Map`, no module-global
 * singletons here. `web-fetch.ts` and `web-search-provider-common.ts` each
 * own their own `Map` and pass it in.
 */

/** Default cache TTL when no per-tool override is set. */
export const DEFAULT_CACHE_TTL_MINUTES = 15;

/** Default cache max entries before FIFO eviction kicks in. */
export const DEFAULT_CACHE_MAX_ENTRIES = 100;

/** Default total request timeout for web ops (ms). */
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** Default max bytes a response body is allowed to grow to before truncation. */
export const DEFAULT_MAX_RESPONSE_BYTES = 750_000;

/** Hard ceiling on the max-bytes knob — operators can't bypass this. */
export const MAX_RESPONSE_BYTES_CEILING = 10 * 1024 * 1024;

/** Hard floor on the max-bytes knob — too small breaks even tiny pages. */
export const MAX_RESPONSE_BYTES_FLOOR = 32 * 1024;

export interface CacheEntry<T> {
	expiresAt: number;
	value: T;
}

/**
 * Lowercase + trim a cache key. The upstream reference does this so a model
 * that calls `web_search("Hello", …)` and `web_search("hello", …)` hits the
 * same entry; URLs with different casing on the scheme/host (which are
 * semantically identical) hit the same fetch entry.
 */
export function normalizeCacheKey(key: string): string {
	return key.trim().toLowerCase();
}

/**
 * Read from a cache map. On hit:
 *   - If the entry is still within TTL, returns the value (with `cached: true`
 *     stamped on if the value is an object).
 *   - If expired, deletes the entry and returns `undefined`.
 * On miss, returns `undefined`.
 *
 * The expired-entry delete is what keeps the map's effective size at the
 * sum of recently-touched-and-valid entries; combined with the size cap
 * eviction in `writeCache`, the map stays bounded.
 */
export function readCache<T>(cache: Map<string, CacheEntry<T>>, rawKey: string): T | undefined {
	const key = normalizeCacheKey(rawKey);
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		cache.delete(key);
		return undefined;
	}
	return entry.value;
}

/**
 * Write to a cache map with FIFO eviction at the size cap. The reference
 * uses FIFO (not LRU) because the workload is "many one-shot keys per
 * session, very few re-fetches" — promoting on read would just churn the
 * Map without changing hit rates.
 *
 * `ttlMs <= 0` disables the write (configurable per-tool to turn off
 * caching entirely without removing the call sites).
 */
export function writeCache<T>(
	cache: Map<string, CacheEntry<T>>,
	rawKey: string,
	value: T,
	opts?: { ttlMs?: number; maxEntries?: number },
): void {
	const ttlMs = opts?.ttlMs ?? DEFAULT_CACHE_TTL_MINUTES * 60_000;
	if (ttlMs <= 0) return;
	const maxEntries = opts?.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
	const key = normalizeCacheKey(rawKey);
	cache.set(key, { expiresAt: Date.now() + ttlMs, value });
	while (cache.size > maxEntries) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** Resolve a configurable TTL value (minutes → ms) with defaults + bounds. */
export function resolveCacheTtlMs(minutes: number | undefined): number {
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
		return DEFAULT_CACHE_TTL_MINUTES * 60_000;
	}
	return Math.floor(minutes * 60_000);
}

export interface BodyReadResult {
	text: string;
	bytesRead: number;
	truncated: boolean;
}

/**
 * Read a Response body as text with a streaming byte cap. Returns the
 * decoded text + the number of bytes actually pulled off the wire + a
 * `truncated` flag. The body is read in chunks via `ReadableStream`
 * reader, and `reader.cancel()` is called the moment we cross the cap —
 * we never buffer the entire body just to slice it.
 *
 * `body` may be null when the upstream returns no body (1xx/204/304).
 * `maxBytes` defaults to `DEFAULT_MAX_RESPONSE_BYTES`; callers should
 * clamp to `[MAX_RESPONSE_BYTES_FLOOR, MAX_RESPONSE_BYTES_CEILING]`.
 *
 * UTF-8 decoding is the only encoding supported (matches the reference);
 * non-UTF-8 pages will display as mojibake. Adding charset sniffing
 * requires reading the Content-Type header and the HTML `<meta charset>`
 * tag — deferred until a real-world page actually breaks.
 */
export async function readResponseText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<BodyReadResult> {
	if (!body) return { text: "", bytesRead: 0, truncated: false };
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	const chunks: string[] = [];
	let bytesRead = 0;
	let truncated = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				// Decode just up to the cap. The slice may cut a multi-byte
				// codepoint — `TextDecoder` with stream:false handles trailing
				// partial sequences by replacement-character; acceptable for
				// truncation.
				const overshoot = bytesRead - maxBytes;
				const usable = value.byteLength - overshoot;
				if (usable > 0) {
					chunks.push(decoder.decode(value.subarray(0, usable), { stream: false }));
				}
				truncated = true;
				try {
					await reader.cancel();
				} catch {
					/* cancel best-effort */
				}
				break;
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		// Flush any trailing partial multi-byte sequence (stream: false).
		if (!truncated) chunks.push(decoder.decode());
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* already released */
		}
	}
	return { text: chunks.join(""), bytesRead, truncated };
}

/** Clamp a max-bytes knob into the supported range. */
export function clampMaxBytes(maxBytes: number | undefined): number {
	const v =
		typeof maxBytes === "number" && Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_RESPONSE_BYTES;
	return Math.min(MAX_RESPONSE_BYTES_CEILING, Math.max(MAX_RESPONSE_BYTES_FLOOR, Math.floor(v)));
}

/**
 * Build a stable cache key for search calls — provider id first, then all
 * query params (any `undefined` becomes the literal "default"), joined
 * with `:` and lowercased. Provider-first ordering means different
 * providers' results never collide on a shared cache.
 */
export function buildSearchCacheKey(parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
	return normalizeCacheKey(
		parts.map((p) => (p === null || p === undefined ? "default" : String(p))).join(":"),
	);
}

/**
 * Truncate text to a char budget with an explicit `[truncated]` marker. The
 * `…` ellipsis matches the reference; the marker text is verbose so a
 * model debugging an unexpected cutoff sees clearly what happened.
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, maxChars)}\n\n[truncated — content exceeded ${maxChars} characters]`,
		truncated: true,
	};
}

/**
 * Build a CACHE-key-safe string from a URL — for the fetch tool's key
 * (`fetch:<url>:<mode>:<maxChars>`) we lowercase the whole composed key
 * but keep the URL as the user typed it; URL canonicalisation (sorting
 * query params, stripping fragments) is intentionally NOT done — matches
 * the reference, and the marginal extra cache hits aren't worth the
 * semantics complexity.
 */
export function buildFetchCacheKey(args: { url: string; extractMode: string; maxChars: number }): string {
	return normalizeCacheKey(`fetch:${args.url}:${args.extractMode}:${args.maxChars}`);
}

/**
 * Redact a URL for debug logging — show scheme + host only, hide path +
 * query + fragment. Useful for "we fetched this URL" log lines that
 * shouldn't leak PII-bearing query strings or session tokens.
 */
export function redactUrlForDebugLog(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		return `${u.protocol}//${u.host}/...`;
	} catch {
		return "(invalid url)";
	}
}
