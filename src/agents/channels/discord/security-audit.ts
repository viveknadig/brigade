/**
 * Discord security audit — the structured findings `brigade doctor` renders via
 * the central `channel-security-registry.ts` (`collectChannelSecurityAudit`).
 *
 * The single concern here: name-based (MUTABLE) allow-from entries. A Discord
 * username/tag can be changed by its owner, so an allow-list keyed on a name can
 * silently grant access to a DIFFERENT person later. Id-based entries (`123`,
 * `<@123>`, `user:123`) are stable and fine; bare names / tags / empty-prefixed
 * entries get a `warn` finding telling the operator to use stable ids.
 *
 * Walks `channels.discord.allowFrom`, `channels.discord.dm.allowFrom`, and the
 * per-guild `channels.discord.guilds.<id>.users` +
 * `channels.discord.guilds.<id>.channels.<id>.users` lists (plus the per-account
 * variants). Pure-ish: reads only the supplied config. Defensive — a malformed
 * shape contributes nothing.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelSecurityAuditFinding } from "../types.adapters.js";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";

const CHANNEL_ID = "discord";

/** Collect mutable (name-based) entries from one allow-from list into the set, with source labels. */
function collectMutableEntries(values: unknown, source: string, into: Set<string>): void {
	if (!Array.isArray(values)) return;
	for (const value of values) {
		const text = String(value ?? "").trim();
		if (!text || !isDiscordMutableAllowEntry(text)) continue;
		into.add(`${source}: ${text}`);
	}
}

/** Read the `channels.discord` slot loosely (schema keeps it open). */
function discordSlot(cfg: BrigadeConfig): Record<string, unknown> | undefined {
	const slot = (cfg as { channels?: Record<string, unknown> }).channels?.[CHANNEL_ID];
	return slot && typeof slot === "object" ? (slot as Record<string, unknown>) : undefined;
}

/**
 * Collect Discord security audit findings. Returns a single `warn` finding when
 * the allow-lists contain name/tag (mutable-identity) entries, naming a few
 * examples; returns `[]` when every entry is a stable id. The `accountId` (when
 * supplied) selects the per-account allow-list in addition to the top-level one.
 */
export function collectDiscordSecurityAuditFindings(params: {
	cfg: BrigadeConfig;
	accountId?: string | null;
}): ChannelSecurityAuditFinding[] {
	const slot = discordSlot(params.cfg);
	if (!slot) return [];
	const accountId = (params.accountId ?? "").trim();
	const mutable = new Set<string>();

	// Top-level allow-from + dm.allowFrom.
	collectMutableEntries(slot.allowFrom, "channels.discord.allowFrom", mutable);
	const dm = slot.dm as { allowFrom?: unknown } | undefined;
	collectMutableEntries(dm?.allowFrom, "channels.discord.dm.allowFrom", mutable);

	// Per-account allow-from (when an account is in scope).
	if (accountId) {
		const accounts = Array.isArray(slot.accounts) ? (slot.accounts as Array<Record<string, unknown>>) : [];
		for (const entry of accounts) {
			if (typeof entry?.id === "string" && entry.id.trim() === accountId) {
				collectMutableEntries(entry.allowFrom, `channels.discord.accounts.${accountId}.allowFrom`, mutable);
			}
		}
	}

	// Per-guild users + per-channel users.
	const guilds = slot.guilds;
	if (guilds && typeof guilds === "object") {
		for (const [guildKey, guildValue] of Object.entries(guilds as Record<string, unknown>)) {
			if (!guildValue || typeof guildValue !== "object") continue;
			const guild = guildValue as Record<string, unknown>;
			collectMutableEntries(guild.users, `channels.discord.guilds.${guildKey}.users`, mutable);
			const channels = guild.channels;
			if (!channels || typeof channels !== "object") continue;
			for (const [channelKey, channelValue] of Object.entries(channels as Record<string, unknown>)) {
				if (!channelValue || typeof channelValue !== "object") continue;
				const channel = channelValue as Record<string, unknown>;
				collectMutableEntries(channel.users, `channels.discord.guilds.${guildKey}.channels.${channelKey}.users`, mutable);
			}
		}
	}

	if (mutable.size === 0) return [];
	const examples = Array.from(mutable).slice(0, 5);
	const more = mutable.size > examples.length ? ` (+${mutable.size - examples.length} more)` : "";
	return [
		{
			checkId: "channels.discord.allowFrom.name_based_entries",
			severity: "warn",
			title: "Discord allowlist contains name or tag entries",
			detail:
				"Discord name/tag allowlist matching keys on a mutable identity — a username can be changed by its owner and later resolve to a different person. " +
				`Found: ${examples.join(", ")}${more}.`,
			remediation:
				"Prefer stable Discord ids (a numeric id, <@id>, or user:<id>) in channels.discord.allowFrom and channels.discord.guilds.*.users.",
		},
	];
}
