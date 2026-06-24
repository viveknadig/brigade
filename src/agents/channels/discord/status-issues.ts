/**
 * Discord structured status-issues — the rollup the central status surface
 * renders (`collectStatusIssues` on the plugin's status adapter).
 *
 * Two issue families:
 *   - `intent`      — the privileged MESSAGE CONTENT intent is disabled (the bot
 *                     connects but can't read normal channel messages).
 *   - `permissions` — a channel-permission audit found the bot missing
 *                     `ViewChannel` / `SendMessages` (or couldn't be evaluated),
 *                     OR some configured channel ids weren't numeric snowflakes
 *                     (the audit can only check numeric ids).
 *
 * Returns the central `ChannelStatusIssue[]` (`{ accountId, severity, message }`)
 * so the rollup view + `brigade doctor` render Discord health alongside other
 * channels. Pure + total — given a probe result + an audit result, it derives
 * the rows; no I/O of its own.
 */

import type { ChannelStatusIssue } from "../types.core.js";
import type { DiscordPermissionAuditResult } from "./permission-audit.js";
import type { DiscordProbeResult } from "./probe.js";

/** One account's diagnostics fed to {@link collectDiscordStatusIssues}. */
export interface DiscordStatusAccount {
	accountId: string;
	/** The `/users/@me` probe result (carries the decoded intents). */
	probe?: DiscordProbeResult;
	/** The channel-permission audit result, when one was run. */
	audit?: DiscordPermissionAuditResult;
}

/**
 * Derive the structured status issues for one or more Discord accounts. Emits an
 * `intent` warning when MESSAGE CONTENT is disabled, an `error` per channel that
 * failed the permission audit, and a `warn` when some configured channel ids
 * weren't numeric (so couldn't be audited). Accounts with clean diagnostics
 * contribute nothing.
 */
export function collectDiscordStatusIssues(accounts: DiscordStatusAccount[]): ChannelStatusIssue[] {
	const issues: ChannelStatusIssue[] = [];
	for (const account of accounts ?? []) {
		const accountId = (account?.accountId ?? "").trim();
		if (!accountId) continue;

		// ── intent (message content) ──
		const intents = account.probe?.privilegedIntents;
		const messageContent = intents?.messageContent ?? account.probe?.messageContentIntent;
		if (messageContent === "disabled") {
			issues.push({
				accountId,
				severity: "warn",
				message:
					"Message Content Intent is disabled — the bot can't read normal channel messages. Enable it in the Discord Developer Portal → Bot → Privileged Gateway Intents, or run mention-only.",
			});
		}

		// ── permissions (channel audit) ──
		const audit = account.audit;
		if (audit) {
			if (audit.unresolvedChannels > 0) {
				issues.push({
					accountId,
					severity: "warn",
					message: `Some configured guild channels are not numeric ids (unresolvedChannels=${audit.unresolvedChannels}). The permission audit can only check numeric channel ids — use numeric ids in channels.discord.guilds.*.channels.`,
				});
			}
			for (const channel of audit.channels ?? []) {
				if (channel.ok) continue;
				const missing = channel.missingRequired?.length ? ` missing ${channel.missingRequired.join(", ")}` : "";
				const error = channel.error ? `: ${channel.error}` : "";
				issues.push({
					accountId,
					severity: "error",
					message: `Channel ${channel.channelId} permission check failed.${missing}${error} Ensure the bot role can view + send in this channel (and that channel overrides don't deny it).`,
				});
			}
		}
	}
	return issues;
}
