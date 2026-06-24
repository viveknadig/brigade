/**
 * Slack Block Kit rendering for native approval prompts.
 *
 * When a channel-routed turn raises an exec/plugin approval AND the Slack
 * adapter has opted into `approvalCapability.sendApprovalPrompt`, the central
 * approval-router asks this channel to render the question as native Block Kit
 * BUTTONS instead of the default "reply yes/no" text card. The button payloads
 * are produced by the CENTRAL codec (`buildApprovalCallbackButtons`) so the
 * press comes back as an `InboundMessage.callbackQuery` the central
 * `tryConsumeChannelApprovalCallback` decodes + resolves — this file only maps
 * the codec's `{ label, data }` specs onto Slack's `actions`-block shape (via
 * `blocks.ts`) and assembles the prompt text + fallback.
 *
 * SAFETY: every button `value` here is the codec's output — versioned,
 * base64url + printable-ASCII, already proven `<= 64` UTF-8 bytes by
 * `encodeApprovalCallback` (and well under Slack's 255-char `value` cap). This
 * module never mints its own payloads.
 *
 * Slack mirror of `telegram/approval-native.ts`.
 */

import { buildApprovalCallbackButtons, decodeApprovalCallback } from "../sdk.js";
import {
	buildSlackApprovalBlocks,
	extractBlockActionPayload,
	type SlackActionsBlock,
	type SlackBlock,
	type SlackBlockAction,
} from "./blocks.js";

/** C0/C1 control-character class (incl. NUL) — never a raw control byte in source. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** The Slack message payload an approval prompt sends: a fallback `text` + `blocks`. */
export interface SlackApprovalMessage {
	/** Plain fallback text (notifications + clients that can't render blocks). */
	text: string;
	/** The Block Kit blocks: a section (prompt) + the actions block(s). */
	blocks: SlackBlock[];
}

/**
 * Build the Block Kit approval message for an approval prompt from the central
 * codec. Returns `null` when fewer than two byte-safe buttons could be minted (a
 * pathologically long approval id) — the caller then falls back to the text
 * prompt rather than ship a half-rendered prompt.
 *
 * `allowAlways: false` drops the "Allow always" button (approvals where
 * persisting an allowlist entry doesn't apply).
 */
export function buildSlackApprovalMessage(args: {
	approvalId: string;
	command: string;
	approvalKind: "exec" | "plugin";
	toolName?: string;
	allowAlways?: boolean;
}): SlackApprovalMessage | null {
	const specs = buildApprovalCallbackButtons({
		approvalId: args.approvalId,
		...(args.allowAlways === false ? { allowAlways: false } : {}),
	});
	if (specs.length < 2) return null; // not enough buttons → caller uses text prompt
	const actionBlocks: SlackActionsBlock[] = buildSlackApprovalBlocks(specs);
	if (actionBlocks.length === 0) return null;
	const promptText = buildSlackApprovalText({
		command: args.command,
		approvalKind: args.approvalKind,
		...(args.toolName !== undefined ? { toolName: args.toolName } : {}),
	});
	const blocks: SlackBlock[] = [{ type: "section", text: { type: "mrkdwn", text: promptText } }, ...actionBlocks];
	return { text: promptText, blocks };
}

/**
 * Compose the operator-facing approval question text rendered ABOVE the buttons.
 * Kept short + control-char-scrubbed; the buttons carry the action, so the text
 * only needs the command preview + a one-line ask. The 🦁 mark is the Brigade
 * brand-stamp so the operator recognises this as a Brigade prompt. The command
 * preview is wrapped in a Slack code span (single backticks) so it renders
 * verbatim.
 */
export function buildSlackApprovalText(args: {
	command: string;
	approvalKind: "exec" | "plugin";
	toolName?: string;
	agentId?: string;
}): string {
	const flat = args.command
		.replace(/[\r\n]+/g, " ")
		// oxlint-disable-next-line no-control-regex
		.replace(CONTROL_CHARS_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
	const preview = flat.length <= 180 ? flat : `${flat.slice(0, 177)}…`;
	const what = args.approvalKind === "plugin" ? "run a plugin action" : "run a shell command";
	const lines = [`🦁 Brigade wants to ${what}:`, `\`${preview}\``, "", "Choose below — times out in 5 minutes."];
	return lines.join("\n");
}

/**
 * Parse a `block_actions` interaction's button press into the pending-approval
 * id + decision. Pulls the codec payload out of the first Brigade-owned approval
 * action (via {@link extractBlockActionPayload}) and decodes it with the CENTRAL
 * codec. Returns `null` when the press wasn't an approval button (a general
 * button, or someone else's action) so the caller can fall through.
 */
export function parseSlackApprovalAction(
	actions: ReadonlyArray<SlackBlockAction> | undefined,
): { approvalId: string; decision: "allow-once" | "allow-always" | "deny" } | null {
	const payload = extractBlockActionPayload(actions);
	if (!payload) return null;
	return decodeApprovalCallback(payload);
}
