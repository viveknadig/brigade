/**
 * Cross-channel canonical-peer resolver.
 *
 * Brand-scrubbed lift of the upstream reference codebase's private
 * `resolveLinkedPeerId` (in `src/routing/session-key.ts:178-222`),
 * promoted to its own module so:
 *   - the session-key builder + the channel manager + the cross-session
 *     send tool all share ONE implementation,
 *   - tests can exercise the resolver in isolation,
 *   - future consumers (UI session-router, analytics) import without
 *     dragging the whole session-key module.
 *
 * The algorithm is verbatim. For each `{canonical: [aliases]}` entry in
 * `identityLinks`, the resolver checks if the inbound peer id matches
 * (or, scoped by channel, `channel:peerId` matches) any of the aliases.
 * First canonical match wins. Returns `null` when no match — callers
 * fall back to the raw peer id.
 *
 * Use case: an operator chats with the same human via WhatsApp
 * (`+91 77026 16808`) and via Telegram (`@kartheek`). Config maps both
 * aliases to canonical `"kartheek"`. With `dmScope: "per-peer"`, both
 * inbounds route to `agent:main:direct:kartheek` — one session, two
 * surfaces. Without identity-links, they'd be two separate sessions.
 */

import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

function normalizeToken(value: string | undefined | null): string {
	return normalizeLowercaseStringOrEmpty(value);
}

/**
 * Resolve a cross-channel canonical peer id from an `identityLinks` map.
 *
 * Algorithm (verbatim from upstream):
 *   1. Build a candidate set with two normalised forms:
 *      a. The raw peer id alone (`+91 77026 16808` → `+91 77026 16808`)
 *      b. The channel-scoped form (`whatsapp:+91 77026 16808`)
 *   2. For each canonical name in `identityLinks`, scan its alias array.
 *   3. If any alias normalises into the candidate set, return the canonical.
 *   4. No match → return `null` (caller uses raw peer id as-is).
 *
 * Returns the canonical name UNTRIMMED apart from leading/trailing
 * whitespace — preserves the operator's chosen casing (so display layers
 * can render `Kartheek` not `kartheek`).
 */
export function resolveLinkedPeerId(params: {
	identityLinks?: Record<string, string[]>;
	channel: string;
	peerId: string;
}): string | null {
	const identityLinks = params.identityLinks;
	if (!identityLinks) {
		return null;
	}
	const peerId = params.peerId.trim();
	if (!peerId) {
		return null;
	}
	const candidates = new Set<string>();
	const rawCandidate = normalizeToken(peerId);
	if (rawCandidate) {
		candidates.add(rawCandidate);
	}
	const channel = normalizeToken(params.channel);
	if (channel) {
		const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
		if (scopedCandidate) {
			candidates.add(scopedCandidate);
		}
	}
	if (candidates.size === 0) {
		return null;
	}
	for (const [canonical, ids] of Object.entries(identityLinks)) {
		const canonicalName = canonical.trim();
		if (!canonicalName) {
			continue;
		}
		if (!Array.isArray(ids)) {
			continue;
		}
		for (const id of ids) {
			const normalized = normalizeToken(id);
			if (normalized && candidates.has(normalized)) {
				return canonicalName;
			}
		}
	}
	return null;
}
