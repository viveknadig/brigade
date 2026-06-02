/**
 * Config-bound wrapper around the cross-channel identity resolver.
 *
 * The lower-level `resolveLinkedPeerId` (at `routing/identity-links.ts`)
 * takes an explicit `identityLinks` map. Most callers don't want to
 * thread that map through their call signature — they have a
 * `BrigadeConfig` in hand and want the resolver to read
 * `config.session.identityLinks` themselves.
 *
 * This wrapper closes that gap:
 *
 *   - `getIdentityLinksFromConfig(config)` extracts the map.
 *   - `resolveLinkedPeerIdFromConfig({config, channel, peerId})` runs the
 *     resolver against the config's map in one call.
 *   - Re-exports `resolveLinkedPeerId` so callers that DO want the raw
 *     resolver can import from this same module path.
 *
 * Callers in the lifted route resolver, the channel manager, and the
 * cross-session send tool all use the config-bound variant — they're
 * already operating with the active config in scope.
 */

import type { BrigadeConfig } from "../config/types.js";
import { resolveLinkedPeerId } from "./routing/identity-links.js";

export { resolveLinkedPeerId } from "./routing/identity-links.js";

/**
 * Extract the `identityLinks` map from a config (or return `undefined`
 * when the operator has not configured any aliases). Returned reference
 * is read-only by contract — never mutate.
 */
export function getIdentityLinksFromConfig(
	config: BrigadeConfig | undefined | null,
): Record<string, string[]> | undefined {
	return config?.session?.identityLinks;
}

/**
 * Resolve a cross-channel canonical peer id using the active config's
 * `session.identityLinks` map. Returns `null` when:
 *   - no `identityLinks` are configured,
 *   - the peer id is empty,
 *   - or no alias matches the inbound peer.
 *
 * Callers fall back to the raw peer id on `null`.
 */
export function resolveLinkedPeerIdFromConfig(params: {
	config: BrigadeConfig | undefined | null;
	channel: string;
	peerId: string;
}): string | null {
	const identityLinks = getIdentityLinksFromConfig(params.config);
	if (!identityLinks) return null;
	return resolveLinkedPeerId({
		identityLinks,
		channel: params.channel,
		peerId: params.peerId,
	});
}
