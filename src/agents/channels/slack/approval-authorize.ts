/**
 * Slack inline-approval authorization.
 *
 * When an approval prompt is rendered as Block Kit buttons, ANY member who can
 * see the message could press a button. Brigade's central inbound pipeline
 * already runs the access-control gate before a `block_actions` press reaches
 * the approval-callback path, so only an admitted (allow-listed / owner) peer
 * gets here at all — but a SHARED Slack channel is the edge case: in a channel
 * the bot is in, an admitted member's button press should still be allowed only
 * when that presser is an approved approver, not merely present in the room.
 * Slack's multi-member workspaces make this gate more load-bearing than
 * Telegram's.
 *
 * This predicate is the channel's `approvalCapability.authorizeApprover`. It is
 * invoked CENTRALLY by `tryConsumeChannelApprovalCallback` with the presser's
 * `senderId` (the Slack user id `U…`); returning `{ authorized: false, reason }`
 * refuses the press without consuming the operator's pending approval (so the
 * real operator can still answer). Policy:
 *
 *   - When the channel has an explicit allow-from list configured (the approved
 *     senders), only those ids may approve.
 *   - When NO allow-from list is configured, defer to the access gate that
 *     already admitted the inbound and authorize the press (matches the text-
 *     reply path, which has no extra approver gate).
 *
 * Pure + deterministic over its `cfg` + `senderId` inputs — no I/O.
 */

import type { BrigadeConfig } from "../../../config/io.js";

/** Read the channel's configured allow-from sender ids (string-normalized). */
function configuredAllowFrom(cfg: BrigadeConfig, accountId?: string): string[] {
	const channels = (cfg as { channels?: Record<string, unknown> }).channels;
	const slot = channels?.slack as
		| { allowFrom?: Array<string | number>; accounts?: Array<{ id?: string; allowFrom?: Array<string | number> }> }
		| undefined;
	if (!slot) return [];
	const ids: string[] = [];
	const push = (list?: Array<string | number>) => {
		for (const v of list ?? []) {
			const s = String(v).trim();
			if (s) ids.push(s);
		}
	};
	push(slot.allowFrom);
	// Per-account allow-from (multi-workspace shape) when an accountId is supplied.
	if (accountId && Array.isArray(slot.accounts)) {
		for (const entry of slot.accounts) {
			if (entry && typeof entry.id === "string" && entry.id.trim() === accountId.trim()) push(entry.allowFrom);
		}
	}
	return ids;
}

/**
 * Resolve whether `senderId` is allowed to answer a Slack inline approval.
 * Returns `{ authorized: true }` when no explicit allow-from gate applies (the
 * central access gate already admitted the inbound), or when the presser is on
 * the configured allow-from list. Otherwise refuses with a reason.
 */
export function resolveSlackApprover(args: {
	cfg: BrigadeConfig;
	senderId?: string;
	accountId?: string;
}): { authorized: boolean; reason?: string } {
	const allow = configuredAllowFrom(args.cfg, args.accountId);
	// No explicit allow list → defer to the access gate that already ran.
	if (allow.length === 0) return { authorized: true };
	const sender = (args.senderId ?? "").trim();
	if (sender && allow.includes(sender)) return { authorized: true };
	return {
		authorized: false,
		reason: "Only an approved sender can answer that approval.",
	};
}
