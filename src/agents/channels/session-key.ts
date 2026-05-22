/**
 * Channel session keys.
 *
 * Every conversation on a channel maps to its own Brigade session key, so the
 * agent keeps a distinct transcript per chat (a WhatsApp DM with Alice and one
 * with Bob never share context). The format mirrors the gateway's
 * `defaultSessionKey` (`agent:<id>:main`) but adds the channel + conversation
 * scope, kept flat here since Brigade is single-agent in this phase.
 */

import { createHash } from "node:crypto";

/** Make a segment readable + safe, without losing uniqueness. */
function readableSegment(value: string): string {
	return (
		value
			.trim()
			.replace(/[\s:]+/g, "_") // collapse whitespace + the reserved ":" separator
			.replace(/[^\w.@+-]/g, "") || "x" // keep id-safe punctuation; never empty
	);
}

/**
 * Conversation segment: a readable prefix PLUS a short hash of the RAW id. The
 * readable part is for humans scanning the session store; the hash guarantees
 * two distinct conversation ids can never collapse to the same key (e.g.
 * `"a:b"` and `"a b"` both sanitize to `a_b` but hash differently), which would
 * otherwise bleed one chat's context into another.
 */
function conversationSegment(conversationId: string): string {
	const hash = createHash("sha256").update(conversationId).digest("hex").slice(0, 8);
	return `${readableSegment(conversationId)}.${hash}`;
}

/**
 * Build the per-conversation session key for a channel message.
 * e.g. `channelSessionKey("main", "whatsapp", "1234567890@s.whatsapp.net")`
 *   → `agent:main:whatsapp:1234567890@s.whatsapp.net.<hash>`
 */
export function channelSessionKey(agentId: string, channel: string, conversationId: string): string {
	return `agent:${agentId}:${readableSegment(channel)}:${conversationSegment(conversationId)}`;
}
