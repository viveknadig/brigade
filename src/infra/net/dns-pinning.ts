/**
 * DNS-pinned dispatcher for SSRF-guarded fetch.
 *
 * The basic SSRF guard resolves a hostname's IP, checks it against the
 * refuse list, and then hands the request off to `fetch()`. There's a
 * window between those two events: a hostile DNS server can return a
 * public IP to the guard, then a private IP to the socket. This is the
 * classic DNS-rebinding TOCTOU attack.
 *
 * To close it, we pre-resolve the hostname ourselves, pick the first
 * answer that PASSES the SSRF check, and force the actual TCP connect
 * to use THAT exact IP via undici's `Agent.connect.lookup` hook. The
 * Host header still reads as the original hostname so TLS SNI + cert
 * validation keep working.
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
 * Resolve the hostname → list of A/AAAA records. Equivalent to
 * `dns.lookup(host, {all:true})` but returned in a stable shape.
 * Throws on resolution failure.
 */
export async function resolveAll(hostname: string): Promise<LookupAddress[]> {
	return await dnsPromises.lookup(hostname, { all: true });
}

/**
 * Build a per-call undici Agent whose `connect.lookup` only returns the
 * pinned IP, regardless of what the system resolver says at connect
 * time. This is the TOCTOU fix — even if DNS records flip between our
 * pre-resolve and the actual socket connect, undici dials the IP we
 * already vetted.
 *
 * Caller is responsible for closing the agent (or letting it GC) once
 * the request completes.
 */
export async function createPinnedDispatcher(args: {
	hostname: string;
	pinnedIp: string;
	pinnedFamily: 4 | 6;
}): Promise<UndiciAgent> {
	const { Agent } = await loadUndici();
	return new Agent({
		// Custom DNS hook — undici calls this for every TCP connect. We
		// ignore the requested hostname and always return our pinned IP.
		// Note: the hostname argument may differ from `args.hostname` on
		// redirects, but the calling SSRF guard re-pins per hop anyway.
		connect: {
			lookup: (
				_hostname: string,
				_options: unknown,
				cb: (err: Error | null, addr: string, family: number) => void,
			) => {
				cb(null, args.pinnedIp, args.pinnedFamily);
			},
		},
	});
}

/**
 * One-shot helper: resolve, classify, pick the first safe address, and
 * return a pinned dispatcher. Returns `null` when no resolved address
 * passes the SSRF check (caller should refuse the fetch).
 */
export async function buildPinnedDispatcherForHostname(args: {
	hostname: string;
	classifyAddress: (addr: string, family: 4 | 6) => string | null;
}): Promise<{ dispatcher: UndiciAgent; address: string; family: 4 | 6 } | null> {
	const records = await resolveAll(args.hostname);
	for (const r of records) {
		const family = r.family === 6 ? 6 : 4;
		const reason = args.classifyAddress(r.address, family);
		if (reason) continue;
		const dispatcher = await createPinnedDispatcher({
			hostname: args.hostname,
			pinnedIp: r.address,
			pinnedFamily: family,
		});
		return { dispatcher, address: r.address, family };
	}
	return null;
}
