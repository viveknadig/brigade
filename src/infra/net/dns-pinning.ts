/**
 * DNS-pinned dispatcher for SSRF-guarded fetch.
 *
 * The basic SSRF guard resolves a hostname's IP, checks it against the
 * refuse list, and then hands the request off to `fetch`. There's a
 * window between those two events: a hostile DNS server can return a
 * public IP to the guard, then a private IP to the socket. This is the
 * classic DNS-rebinding TOCTOU attack.
 *
 * To close it, we pre-resolve the hostname ourselves, pick the answers
 * that PASS the SSRF check, and force the actual TCP connect to use one
 * of THOSE EXACT IPs via undici's `Agent.connect.lookup` hook. The Host
 * header still reads as the original hostname so TLS SNI + cert
 * validation keep working.
 *
 * The `lookup` callback must match `dns.lookup`'s contract — when
 * `opts.all === true`, we return an array of `{address, family}`
 * objects; otherwise we return a single triple. Earlier revisions
 * returned only the single-triple shape; undici 7+ calls with
 * `opts.all: true` and that mismatch surfaces as
 * `Invalid IP address: undefined`.
 */

import { promises as dnsPromises, type LookupAddress } from "node:dns";

import type { Agent as UndiciAgent } from "undici";

let undiciP: Promise<typeof import("undici")> | null = null;

async function loadUndici(): Promise<typeof import("undici")> {
	if (!undiciP) {
		undiciP = import("undici").catch((err) => {
			undiciP = null;
			throw err;
		});
	}
	return undiciP;
}

/**
 * Resolve the hostname → list of A/AAAA records. Throws on resolution failure.
 */
export async function resolveAll(hostname: string): Promise<LookupAddress[]> {
	return await dnsPromises.lookup(hostname, { all: true });
}

interface PinnedAddress {
	address: string;
	family: 4 | 6;
}

/**
 * Build a per-call undici Agent that locks the TCP connect to one of the
 * pre-resolved + SSRF-vetted IPs, regardless of what the system resolver
 * says at connect time.
 */
export async function createPinnedDispatcher(args: {
	hostname: string;
	pinned: ReadonlyArray<PinnedAddress>;
}): Promise<UndiciAgent> {
	const { Agent } = await loadUndici();
	const normalizedHost = args.hostname.toLowerCase();
	let rrIndex = 0;
	return new Agent({
		connect: {
			lookup: ((
				host: string,
				options: { all?: boolean; family?: number; hints?: number } | undefined,
				callback: (
					err: NodeJS.ErrnoException | null,
					addressOrAll?: string | LookupAddress[],
					family?: number,
				) => void,
			) => {
				// Re-resolve any host that isn't our pinned one via the
				// system resolver. This covers redirects to other hosts —
				// the outer guard will re-pin per hop, but undici's
				// internal connection-pool reuse can ask `lookup` for the
				// proxy host too. Falling back to the system resolver
				// keeps those cases working.
				const target = (host ?? "").toLowerCase();
				if (target && target !== normalizedHost) {
					import("node:dns").then(({ lookup }) => {
						// Mirror the same shape the caller asked for.
						if (options?.all) {
							lookup(host, { all: true }, (err, addrs) => callback(err, addrs as LookupAddress[]));
						} else {
							const family = options?.family;
							lookup(host, family ? { family } : {}, (err, address, fam) =>
								callback(err, address, fam),
							);
						}
					});
					return;
				}

				// Filter by requested family if the caller specified one.
				const wantedFamily = options?.family;
				const candidates = wantedFamily
					? args.pinned.filter((p) => p.family === wantedFamily)
					: args.pinned;
				if (candidates.length === 0) {
					callback(Object.assign(new Error("no usable pinned address"), { code: "ENOTFOUND" }));
					return;
				}

				if (options?.all) {
					callback(
						null,
						candidates.map((p) => ({ address: p.address, family: p.family })) as LookupAddress[],
					);
					return;
				}
				// Round-robin if multiple are present, mirroring system DNS.
				const chosen = candidates[rrIndex % candidates.length]!;
				rrIndex += 1;
				callback(null, chosen.address, chosen.family);
			}) as never,
		},
	});
}

/**
 * One-shot helper: resolve, classify, keep every record that passes the
 * SSRF check, and return a pinned dispatcher. Returns `null` when no
 * resolved address passes (caller refuses the fetch).
 */
export async function buildPinnedDispatcherForHostname(args: {
	hostname: string;
	classifyAddress: (addr: string, family: 4 | 6) => string | null;
}): Promise<{ dispatcher: UndiciAgent; addresses: PinnedAddress[] } | null> {
	const records = await resolveAll(args.hostname);
	const safe: PinnedAddress[] = [];
	for (const r of records) {
		const family: 4 | 6 = r.family === 6 ? 6 : 4;
		const reason = args.classifyAddress(r.address, family);
		if (reason) continue;
		safe.push({ address: r.address, family });
	}
	if (safe.length === 0) return null;
	const dispatcher = await createPinnedDispatcher({
		hostname: args.hostname,
		pinned: safe,
	});
	return { dispatcher, addresses: safe };
}

/**
 * Lazy-load undici's `fetch` — kept separate from the dispatcher so
 * callers can do `fetch(url, { dispatcher })` using the SAME undici
 * version the dispatcher was built from. Mixing Node's bundled
 * `globalThis.fetch` with an externally-imported undici Agent
 * triggers "invalid onRequestStart method" because the interceptor
 * protocol drifts across versions.
 */
export async function undiciFetch(input: string, init: RequestInit & { dispatcher?: unknown }): Promise<Response> {
	const undici = await loadUndici();
	return (await undici.fetch(input as never, init as never)) as unknown as Response;
}
