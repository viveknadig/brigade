/**
 * Slack slash-command helpers — normalize an inbound `/command` name + map
 * Brigade's central channel commands to a documentable list.
 *
 * Brigade owns the command set centrally (`buildBundledCommands` → `/help`,
 * `/status`, `/allowlist`, `/agent`, `/agents`, `/whoami`, `/org`, plus any
 * module-registered channel commands). Telegram mirrors that set into the bot's
 * `setMyCommands` menu on connect. SLACK IS DIFFERENT: slash commands are
 * registered MANUALLY in the Slack app config UI (each `/command` points at the
 * app's request URL / Socket Mode), so there is NO programmatic "set my
 * commands" call. This module is therefore lighter than Telegram's — it provides:
 *
 *   1. {@link normalizeSlackCommandName} — canonicalise an inbound
 *      `slash_commands` event's `command` (e.g. `/Help` → `help`) so the
 *      adapter can match it against the central command map.
 *   2. {@link buildSlackCommandManifest} — map the central commands to a plain
 *      `{ command, description }[]` the operator copies into the Slack app's
 *      slash-command config (surfaced in docs / `brigade channels status`).
 *
 * Pure / deterministic — no I/O. Output command names are printable ASCII
 * (`[a-z0-9_-]`), so no NUL / control byte can appear.
 */

import type { ChannelCommand } from "../sdk.js";

/** A Slack slash-command manifest entry (for the app-config UI / docs). */
export interface SlackSlashCommand {
	/** Command WITHOUT the leading slash, e.g. `status`. */
	command: string;
	/** Short description shown in the Slack command hint. */
	description: string;
}

/** Slack slash-command limits (the app-config UI enforces these). */
const MAX_COMMANDS = 100;
const MAX_NAME_LEN = 32;
const MAX_DESC_LEN = 2000;
/** Slack allows `[a-z0-9_-]` in a slash command name (lowercased). */
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Normalize a command word to Slack's `[a-z0-9_-]{1,32}` shape, or null if
 * unusable. Strips a leading `/`, lowercases, and drops disallowed chars.
 */
export function normalizeSlackCommandName(raw: string): string | null {
	const stripped = raw.trim().replace(/^\/+/, "").toLowerCase();
	const cleaned = stripped.replace(/[^a-z0-9_-]/g, "").slice(0, MAX_NAME_LEN);
	if (!cleaned || !COMMAND_NAME_RE.test(cleaned)) return null;
	return cleaned;
}

/** Clamp + flatten a description to a single printable line within Slack's cap. */
function normalizeDescription(desc: string | undefined, fallback: string): string {
	const raw = (desc ?? "").replace(/\s+/g, " ").trim() || fallback;
	return raw.length > MAX_DESC_LEN ? `${raw.slice(0, MAX_DESC_LEN - 1)}…` : raw;
}

/**
 * Build the Slack slash-command manifest from Brigade's central channel
 * commands. De-dupes by normalized name (first wins), drops unusable names, and
 * caps at 100. Returns `[]` when nothing maps. Unlike Telegram this is NOT
 * pushed to Slack on connect — it's the list the operator registers by hand in
 * the Slack app config (and what docs / status surface).
 */
export function buildSlackCommandManifest(commands: ReadonlyArray<ChannelCommand>): SlackSlashCommand[] {
	const out: SlackSlashCommand[] = [];
	const seen = new Set<string>();
	for (const cmd of commands) {
		if (out.length >= MAX_COMMANDS) break;
		const name = normalizeSlackCommandName(cmd.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push({ command: name, description: normalizeDescription(cmd.description, name) });
	}
	return out;
}
