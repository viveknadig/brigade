/**
 * Account-scoped Discord handle → user-id directory cache.
 *
 * Discord's outbound mention token is `<@123>` (a snowflake), but an agent
 * naturally writes a HANDLE — "ping @alex". A plain `@alex` in message content
 * does NOT ping on Discord; only the `<@id>` token resolves. To bridge that the
 * outbound path rewrites a known `@handle` to its `<@id>` token (see
 * `format.ts rewriteKnownMentions`), and THIS module is the lookup table that
 * tells it which handles are known.
 *
 * The cache is primed from inbound traffic: every message author + every
 * resolved mention seen on an inbound is remembered (id ↔ username /
 * display-name / `username#discriminator`). So the bot can mention back anyone
 * it has recently seen, with zero extra REST calls.
 *
 * Shape:
 *   - keyed by account id (a two-account bot must never cross handles);
 *   - an LRU bounded at {@link DISCORD_DIRECTORY_CACHE_MAX} entries per account
 *     (re-inserting a hit moves it to the most-recent slot);
 *   - handle keys are lowercased + `@`-stripped; a `username#1234` discriminator
 *     form is remembered BOTH with and without its discriminator.
 *
 * Pure module-level state (no I/O). A reset hook is exported for tests.
 */

/** Per-account LRU cap. ~4000 distinct handles is far past any real channel. */
export const DISCORD_DIRECTORY_CACHE_MAX = 4_000;

/** Trailing `#1234`-style legacy discriminator. */
const DISCRIMINATOR_SUFFIX = /#\d{4}$/;

/** account id → (lowercased handle → user id), insertion-ordered for LRU. */
const directoryByAccount = new Map<string, Map<string, string>>();

/** Normalize an account id to a stable non-empty cache key. */
function accountKey(accountId?: string | null): string {
	const trimmed = (accountId ?? "").trim();
	return trimmed || "default";
}

/** A Discord user id is a numeric snowflake; reject anything else. */
function normalizeUserId(value: unknown): string | null {
	const text = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
	return /^\d+$/.test(text) ? text : null;
}

/**
 * Normalize a raw handle into a cache key: drop a leading `@`, lowercase, and
 * reject anything with interior whitespace (a multi-word "handle" can't be a
 * Discord username). Returns null when there's nothing usable.
 */
function normalizeHandleKey(raw: unknown): string | null {
	let handle = typeof raw === "string" ? raw.trim() : "";
	if (!handle) return null;
	if (handle.startsWith("@")) handle = handle.slice(1).trim();
	if (!handle || /\s/.test(handle)) return null;
	return handle.toLowerCase();
}

/** Resolve (or create) the LRU map for an account. */
function ensureAccountCache(accountId?: string | null): Map<string, string> {
	const key = accountKey(accountId);
	let cache = directoryByAccount.get(key);
	if (!cache) {
		cache = new Map<string, string>();
		directoryByAccount.set(key, cache);
	}
	return cache;
}

/** Insert/refresh one handle→id entry, evicting the oldest past the cap. */
function setEntry(cache: Map<string, string>, handle: string, userId: string): void {
	// Re-insert to move to most-recent (Map preserves insertion order).
	if (cache.has(handle)) cache.delete(handle);
	cache.set(handle, userId);
	if (cache.size <= DISCORD_DIRECTORY_CACHE_MAX) return;
	const oldest = cache.keys().next();
	if (!oldest.done) cache.delete(oldest.value);
}

/**
 * Remember a Discord user under all of its handle forms for `accountId`:
 * `username`, `displayName`/`globalName`, and `username#discriminator` (the last
 * remembered both with AND without the discriminator). Silent no-op when the id
 * isn't a valid snowflake or no usable handle is supplied.
 */
export function rememberDiscordUser(
	accountId: string | null | undefined,
	user: { id?: unknown; username?: unknown; displayName?: unknown },
): void {
	const userId = normalizeUserId(user.id);
	if (!userId) return;
	const cache = ensureAccountCache(accountId);
	const candidates = [user.username, user.displayName];
	for (const candidate of candidates) {
		const handle = normalizeHandleKey(candidate);
		if (!handle) continue;
		setEntry(cache, handle, userId);
		// `name#1234` → also remember the bare `name`.
		const bare = handle.replace(DISCRIMINATOR_SUFFIX, "");
		if (bare && bare !== handle) setEntry(cache, bare, userId);
	}
}

/**
 * Resolve a `@handle` (with or without the `@`) to a remembered user id for
 * `accountId`, or undefined when unknown. Tries the exact handle first, then the
 * discriminator-stripped form. Re-orders the hit to most-recent so an active
 * handle survives eviction.
 */
export function resolveDiscordHandle(accountId: string | null | undefined, handle: string): string | undefined {
	const cache = directoryByAccount.get(accountKey(accountId));
	if (!cache) return undefined;
	const key = normalizeHandleKey(handle);
	if (!key) return undefined;
	let hit = cache.get(key);
	if (hit === undefined) {
		const bare = key.replace(DISCRIMINATOR_SUFFIX, "");
		if (bare && bare !== key) hit = cache.get(bare);
	}
	if (hit === undefined) return undefined;
	// Touch for LRU recency.
	const touchKey = cache.has(key) ? key : key.replace(DISCRIMINATOR_SUFFIX, "");
	setEntry(cache, touchKey, hit);
	return hit;
}

/** TEST SEAM — clear all account caches between cases. */
export function __resetDiscordDirectoryCacheForTest(): void {
	directoryByAccount.clear();
}
