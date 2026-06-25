/**
 * BlueBubbles contact-name resolution.
 *
 * An inbound BlueBubbles message carries the sender as a raw handle — a phone
 * number (`+15551234567`) or an email. For the agent's context it reads far
 * better as a human display name ("Alex Rivera"). The BlueBubbles server exposes
 * the host Mac's Contacts via `GET /api/v1/contact`, so this module asks the
 * server for the address book ONCE per account, indexes it by a normalised phone
 * key + lowercased email, and resolves a sender address → display name from that
 * cache.
 *
 * The directory is cached per account in a small LRU with a TTL (like Discord's
 * directory cache): the first inbound for an account warms it, subsequent
 * inbound hits the in-memory index. A NEGATIVE result (no match) is cached for a
 * shorter TTL so an unknown number isn't re-queried on every message. `fetch` is
 * INJECTABLE (the test seam) so the whole path runs with no live server.
 */

import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl, type FetchLike } from "./types.js";

/** How long a fetched directory index stays warm before a re-fetch (1h). */
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
/** How long a per-address negative (no-match) result is cached (5m). */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** Cap on the number of accounts whose directory we keep indexed at once. */
const MAX_ACCOUNT_DIRECTORIES = 16;

/** One BlueBubbles contact record (server `GET /api/v1/contact` shape, defensive). */
interface RawBlueBubblesContact {
	displayName?: string;
	firstName?: string;
	lastName?: string;
	nickname?: string;
	phoneNumbers?: Array<{ address?: string } | string>;
	emails?: Array<{ address?: string } | string>;
	[key: string]: unknown;
}

/** A built directory index for one account: phone/email key → display name. */
interface AccountDirectory {
	byKey: Map<string, string>;
	/** Per-address negative cache (address → expiry ms). */
	negative: Map<string, number>;
	expiresAt: number;
}

/** Module-level per-account directory cache (LRU by insertion order). */
const directoryCache = new Map<string, AccountDirectory>();

/** Args every resolution call threads (the REST base + the account scope). */
export interface ResolveContactNameArgs {
	serverUrl: string;
	password: string;
	accountId: string;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
}

/**
 * Normalise a phone-ish string to a comparison key: digits only, dropping a
 * leading US country code so `+1 (555) 123-4567` and `5551234567` collide.
 * Returns null for a too-short / non-numeric value (e.g. an email).
 */
export function normalizePhoneKey(value: string): string | null {
	const digits = (value ?? "").replace(/\D/g, "");
	if (!digits) return null;
	const trimmed = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
	return trimmed.length >= 7 ? trimmed : null;
}

/** Build the lookup key for a sender address (email lowercased, phone digit-normalised). */
export function contactLookupKey(address: string): string | null {
	const trimmed = (address ?? "").trim();
	if (!trimmed) return null;
	if (trimmed.includes("@")) return trimmed.toLowerCase();
	return normalizePhoneKey(trimmed);
}

/** Pull a display name out of a contact record (display → first+last → nickname). */
function contactDisplayName(c: RawBlueBubblesContact): string | undefined {
	const display = (c.displayName ?? "").trim();
	if (display) return display;
	const first = (c.firstName ?? "").trim();
	const last = (c.lastName ?? "").trim();
	const full = `${first} ${last}`.trim();
	if (full) return full;
	const nick = (c.nickname ?? "").trim();
	return nick || undefined;
}

/** Read an address out of a `{ address }` object OR a bare string entry. */
function readAddressEntry(entry: { address?: string } | string | undefined): string | undefined {
	if (typeof entry === "string") return entry.trim() || undefined;
	const addr = (entry?.address ?? "").trim();
	return addr || undefined;
}

/** Build the phone/email → name index from the raw contact list. */
export function buildContactIndex(contacts: RawBlueBubblesContact[]): Map<string, string> {
	const byKey = new Map<string, string>();
	for (const c of contacts) {
		if (!c || typeof c !== "object") continue;
		const name = contactDisplayName(c);
		if (!name) continue;
		for (const phone of c.phoneNumbers ?? []) {
			const addr = readAddressEntry(phone);
			const key = addr ? normalizePhoneKey(addr) : null;
			if (key && !byKey.has(key)) byKey.set(key, name);
		}
		for (const email of c.emails ?? []) {
			const addr = readAddressEntry(email);
			const key = addr ? addr.toLowerCase() : null;
			if (key && !byKey.has(key)) byKey.set(key, name);
		}
	}
	return byKey;
}

/** Touch an account directory to the MRU position (LRU bookkeeping). */
function touch(accountId: string, dir: AccountDirectory): void {
	directoryCache.delete(accountId);
	directoryCache.set(accountId, dir);
	while (directoryCache.size > MAX_ACCOUNT_DIRECTORIES) {
		const oldest = directoryCache.keys().next().value;
		if (oldest === undefined) break;
		directoryCache.delete(oldest);
	}
}

/** Fetch + index the account's contact directory from the server. Never throws. */
async function fetchDirectory(args: ResolveContactNameArgs, now: number): Promise<AccountDirectory> {
	let contacts: RawBlueBubblesContact[] = [];
	try {
		const url = buildBlueBubblesApiUrl({ serverUrl: args.serverUrl, path: "contact", password: args.password });
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{ ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}) },
		);
		if (res.ok) {
			const text = await res.text();
			const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
			const data = body.data;
			if (Array.isArray(data)) contacts = data as RawBlueBubblesContact[];
		}
	} catch {
		contacts = [];
	}
	const dir: AccountDirectory = {
		byKey: buildContactIndex(contacts),
		negative: new Map(),
		expiresAt: now + DIRECTORY_TTL_MS,
	};
	return dir;
}

/**
 * Resolve an inbound sender address → a human display name, or `undefined` when
 * unknown. Warms (and caches) the account's contact directory on first use;
 * subsequent calls hit the in-memory index. Negative results are cached briefly
 * so an unknown number isn't re-queried every message. NEVER throws — a transport
 * failure just yields `undefined` (the message still flows with the raw handle).
 */
export async function resolveBlueBubblesContactName(
	address: string,
	args: ResolveContactNameArgs,
	now: number = Date.now(),
): Promise<string | undefined> {
	const key = contactLookupKey(address);
	if (!key) return undefined;

	let dir = directoryCache.get(args.accountId);
	if (!dir || dir.expiresAt <= now) {
		dir = await fetchDirectory(args, now);
		touch(args.accountId, dir);
	} else {
		touch(args.accountId, dir);
	}

	const hit = dir.byKey.get(key);
	if (hit) return hit;

	// Negative cache: don't re-query the directory mid-TTL for a known miss.
	const negExpiry = dir.negative.get(key);
	if (negExpiry && negExpiry > now) return undefined;
	dir.negative.set(key, now + NEGATIVE_TTL_MS);
	return undefined;
}

/**
 * SYNCHRONOUS cache-only peek: resolve an address from an ALREADY-WARM account
 * directory, or `undefined` when the directory isn't cached yet / it's a miss.
 * Never fetches — use this on the hot inbound path so dispatch stays synchronous;
 * pair it with `warmBlueBubblesContactDirectory` to populate the cache in the
 * background.
 */
export function peekBlueBubblesContactName(address: string, accountId: string, now: number = Date.now()): string | undefined {
	const key = contactLookupKey(address);
	if (!key) return undefined;
	const dir = directoryCache.get(accountId);
	if (!dir || dir.expiresAt <= now) return undefined;
	return dir.byKey.get(key);
}

/**
 * Warm the account's contact directory cache in the background (best-effort).
 * Fetches + indexes ONLY when the cache is cold/expired; a warm cache is a
 * no-op. Never throws. Returns a promise the caller can ignore.
 */
export async function warmBlueBubblesContactDirectory(args: ResolveContactNameArgs, now: number = Date.now()): Promise<void> {
	const existing = directoryCache.get(args.accountId);
	if (existing && existing.expiresAt > now) return;
	const dir = await fetchDirectory(args, now);
	touch(args.accountId, dir);
}

/** Drop every cached account directory (test isolation + reload teardown). */
export function clearBlueBubblesContactCache(): void {
	directoryCache.clear();
}
