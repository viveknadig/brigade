/**
 * Channel session keys.
 *
 * Every conversation on a channel maps to its own Brigade session key, so the
 * agent keeps a distinct transcript per chat (a WhatsApp DM with Alice and one
 * with Bob never share context). The format mirrors the gateway's
 * `defaultSessionKey` (`agent:<id>:main`) but adds the channel + conversation
 * scope — comparable to OpenClaw's `agent:<id>:<channel>:<peerKind>:<peerId>`
 * routing keys, kept flat here since Brigade is single-agent in this phase.
 */

/** Strip characters that would make a session key ambiguous or unsafe on disk. */
function sanitizeSegment(value: string): string {
	return value
		.trim()
		.replace(/[\s:]+/g, "_") // collapse whitespace + reserved ":" separator
		.replace(/[^\w.@+-]/g, "") // keep word chars + a few id-safe punctuation marks
		|| "unknown";
}

/**
 * Build the per-conversation session key for a channel message.
 * e.g. `channelSessionKey("main", "whatsapp", "1234567890@s.whatsapp.net")`
 *   → `agent:main:whatsapp:1234567890_s.whatsapp.net`
 */
export function channelSessionKey(agentId: string, channel: string, conversationId: string): string {
	return `agent:${agentId}:${sanitizeSegment(channel)}:${sanitizeSegment(conversationId)}`;
}
