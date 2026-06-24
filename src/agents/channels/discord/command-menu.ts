/**
 * Discord native command menu — map Brigade's central channel commands onto the
 * application-command payload that Discord's REST `PUT /applications/{id}/commands`
 * (or the per-guild variant) registers, so the operator sees `/help`, `/status`,
 * … as native Discord slash commands.
 *
 * Brigade owns the command set centrally (`buildBundledCommands` → `/help`,
 * `/status`, `/allowlist`, `/agent`, `/agents`, `/whoami`, `/org`, plus any
 * module-registered channel commands). Discord — like Telegram's `setMyCommands`
 * but UNLIKE Slack (whose slash commands are configured by hand in the app UI) —
 * accepts a programmatic registration, so on connect the connection PUTs this
 * manifest. (Discord slash commands carry no positional args by default, so the
 * agent receives `/status` etc. as a bare command; an inbound interaction is
 * normalized back into a `/command` text turn.)
 *
 * Discord's constraints (enforced here so a malformed command never makes the
 * whole `PUT` reject):
 *   - command name: 1–32 chars, lowercase, `[a-z0-9_-]` only (leading `/` stripped).
 *   - description: 1–100 chars (clamped; a non-empty fallback is always emitted
 *     since Discord rejects an empty description).
 *   - at most 100 global commands.
 *   - CHAT_INPUT command type = 1.
 *
 * Pure / deterministic — no I/O. Output command names are printable ASCII
 * (`[a-z0-9_-]`), so no NUL / control byte can appear.
 */

import type { ChannelCommand } from "../sdk.js";

/** A Discord application-command (CHAT_INPUT) registration entry. */
export interface DiscordApplicationCommand {
	/** Command WITHOUT the leading slash, e.g. `status`. */
	name: string;
	/** Short description shown in the Discord command hint (1–100 chars). */
	description: string;
	/** CHAT_INPUT command type (1). */
	type: 1;
}

/** Discord application-command limits. */
const MAX_COMMANDS = 100;
const MAX_NAME_LEN = 32;
const MAX_DESC_LEN = 100;
/** Discord allows lowercase `[a-z0-9_-]` (1–32) in a CHAT_INPUT command name. */
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** CHAT_INPUT application-command type. */
const CHAT_INPUT = 1 as const;

/**
 * Normalize a command word to Discord's `[a-z0-9_-]{1,32}` shape, or null if
 * unusable. Strips a leading `/`, lowercases, and drops disallowed chars.
 */
export function normalizeDiscordCommandName(raw: string): string | null {
	const stripped = raw.trim().replace(/^\/+/, "").toLowerCase();
	const cleaned = stripped.replace(/[^a-z0-9_-]/g, "").slice(0, MAX_NAME_LEN);
	if (!cleaned || !COMMAND_NAME_RE.test(cleaned)) return null;
	return cleaned;
}

/** Clamp + flatten a description to a single printable line within Discord's cap (never empty). */
function normalizeDescription(desc: string | undefined, fallback: string): string {
	const raw = (desc ?? "").replace(/\s+/g, " ").trim() || fallback;
	const clamped = raw.length > MAX_DESC_LEN ? `${raw.slice(0, MAX_DESC_LEN - 1)}…` : raw;
	// Discord rejects an empty description — guarantee at least the fallback name.
	return clamped || fallback;
}

/**
 * Build the Discord application-command manifest from Brigade's central channel
 * commands. De-dupes by normalized name (first wins), drops unusable names, and
 * caps at Discord's 100-command ceiling. Returns `[]` when nothing maps (the
 * connection then skips the REST `PUT` entirely).
 */
export function buildDiscordCommandManifest(commands: ReadonlyArray<ChannelCommand>): DiscordApplicationCommand[] {
	const out: DiscordApplicationCommand[] = [];
	const seen = new Set<string>();
	for (const cmd of commands) {
		if (out.length >= MAX_COMMANDS) break;
		const name = normalizeDiscordCommandName(cmd.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push({ name, description: normalizeDescription(cmd.description, name), type: CHAT_INPUT });
	}
	return out;
}
