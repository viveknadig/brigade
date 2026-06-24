/**
 * Discord SYSTEM-event notes.
 *
 * A Discord message whose `type` is not Default (0) or Reply (19) is a SYSTEM
 * event — a member join, a pin, a server boost, a thread-created marker, an
 * invite reminder, and so on. These carry no user `content`, so without special
 * handling they normalize to empty text and the inbound pipeline drops them —
 * the agent never learns the event happened.
 *
 * This module maps the recognized discord.js `MessageType` enum values to a
 * concise `Discord system: <note>` string the connection synthesizes as the
 * inbound `text` so the event routes through the SAME pipeline as a normal
 * message (no debounce). An UNMAPPED system type returns null → still dropped
 * (we don't flood the agent with every obscure marker).
 *
 * The enum values are inlined (not imported from discord.js) so this module
 * stays dependency-light + unit-testable without a live gateway — the runtime
 * message carries the same numeric `type`. Mirrors the SHAPE of OpenClaw's
 * `monitor/system-events.ts` while speaking discord.js semantics.
 */

import { buildDiscordSenderName, type DiscordMessageLike } from "./inbound-extras.js";

/**
 * discord.js `MessageType` enum values that are SYSTEM events Brigade surfaces.
 * Default (0) + Reply (19) are NOT here — they carry real user content and route
 * through the normal text path. Values mirror discord.js's `MessageType`.
 */
const DISCORD_SYSTEM_EVENT_NOTES: Record<number, string> = {
	1: "added a recipient",
	2: "removed a recipient",
	4: "changed the channel name",
	5: "changed the channel icon",
	6: "pinned a message",
	7: "joined the server",
	8: "boosted the server",
	9: "boosted the server (Tier 1 reached)",
	10: "boosted the server (Tier 2 reached)",
	11: "boosted the server (Tier 3 reached)",
	12: "followed a channel",
	14: "server removed from Discovery",
	15: "server requalified for Discovery",
	18: "created a thread",
	22: "invite reminder",
	24: "auto-moderation action",
	36: "raid protection enabled",
	37: "raid protection disabled",
};

/** The Default + Reply message types — real user content, never a system note. */
const MESSAGE_TYPE_DEFAULT = 0;
const MESSAGE_TYPE_REPLY = 19;

/** True when the message type is one Brigade treats as plain user content (Default or Reply). */
export function isDiscordUserMessageType(type: number | undefined): boolean {
	if (typeof type !== "number") return true; // a fake / absent type → treat as user content
	return type === MESSAGE_TYPE_DEFAULT || type === MESSAGE_TYPE_REPLY;
}

/**
 * A concise `Discord system: <actor> <action> in <location>` note for a
 * recognized system message, or null when the type is Default / Reply / an
 * unmapped system type (so the caller drops it). `location` is a short channel
 * descriptor the caller supplies (e.g. the conversation id) so the agent knows
 * where the event happened.
 */
export function resolveDiscordSystemEvent(message: Pick<DiscordMessageLike, "type" | "author" | "member">, location: string): string | null {
	const type = message.type;
	if (typeof type !== "number" || isDiscordUserMessageType(type)) return null;
	const action = DISCORD_SYSTEM_EVENT_NOTES[type];
	if (!action) return null;
	const actor = buildDiscordSenderName(message as DiscordMessageLike);
	const who = actor ? `${actor} ` : "";
	const where = location.trim() ? ` in ${location.trim()}` : "";
	return `Discord system: ${who}${action}${where}`;
}
