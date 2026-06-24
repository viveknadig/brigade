/**
 * Discord message-component rendering for native approval prompts.
 *
 * When a channel-routed turn raises an exec/plugin approval AND the Discord
 * adapter has opted into `approvalCapability.sendApprovalPrompt`, the central
 * approval-router asks this channel to render the question as native BUTTONS
 * instead of the default "reply yes/no" text card. The button payloads are
 * produced by the CENTRAL codec (`buildApprovalCallbackButtons`) so the press
 * comes back as an `InboundMessage.callbackQuery` the central
 * `tryConsumeChannelApprovalCallback` decodes + resolves — this file only maps
 * the codec's `{ label, data }` specs onto Discord's component-row shape (via
 * `components.ts`) and assembles the prompt text.
 *
 * SAFETY: every button `custom_id` here is the codec's output — versioned,
 * base64url + printable-ASCII, already proven `<= 64` UTF-8 bytes by
 * `encodeApprovalCallback` (and well under Discord's 100-char custom_id cap).
 * This module never mints its own payloads.
 *
 * Discord mirror of `slack/approval-native.ts`.
 */

import { buildApprovalCallbackButtons, decodeApprovalCallback } from "../sdk.js";
import { buildDiscordApprovalRows, type DiscordActionRow } from "./components.js";

/** C0/C1 control-character class (incl. NUL) — never a raw control byte in source. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** The Discord message payload an approval prompt sends: prompt `text` + button `rows`. */
export interface DiscordApprovalMessage {
	/** Prompt body rendered above the buttons. */
	text: string;
	/** The component rows (a row of up to 5 buttons; up to 5 rows). */
	rows: DiscordActionRow[];
}

/**
 * Build the component approval message for an approval prompt from the central
 * codec. Returns `null` when fewer than two byte-safe buttons could be minted (a
 * pathologically long approval id) — the caller then falls back to the text
 * prompt rather than ship a half-rendered prompt.
 *
 * `allowAlways: false` drops the "Allow always" button (approvals where
 * persisting an allowlist entry doesn't apply).
 */
export function buildDiscordApprovalMessage(args: {
	approvalId: string;
	command: string;
	approvalKind: "exec" | "plugin";
	toolName?: string;
	allowAlways?: boolean;
}): DiscordApprovalMessage | null {
	const specs = buildApprovalCallbackButtons({
		approvalId: args.approvalId,
		...(args.allowAlways === false ? { allowAlways: false } : {}),
	});
	if (specs.length < 2) return null; // not enough buttons → caller uses text prompt
	const rows = buildDiscordApprovalRows(specs);
	if (rows.length === 0) return null;
	const text = buildDiscordApprovalText({
		command: args.command,
		approvalKind: args.approvalKind,
		...(args.toolName !== undefined ? { toolName: args.toolName } : {}),
	});
	return { text, rows };
}

/**
 * Compose the operator-facing approval question text rendered ABOVE the buttons.
 * Kept short + control-char-scrubbed; the buttons carry the action, so the text
 * only needs the command preview + a one-line ask. The 🦁 mark is the Brigade
 * brand-stamp so the operator recognises this as a Brigade prompt. The command
 * preview is wrapped in a Discord inline code span (single backticks) so it
 * renders verbatim.
 */
export function buildDiscordApprovalText(args: {
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
 * Parse a pressed button's `custom_id` into the pending-approval id + decision,
 * via the CENTRAL codec. Returns `null` when the press wasn't an approval button
 * (a general button, or a foreign id) so the caller can fall through.
 */
export function parseDiscordApprovalAction(
	customId: string | undefined,
): { approvalId: string; decision: "allow-once" | "allow-always" | "deny" } | null {
	if (!customId) return null;
	return decodeApprovalCallback(customId);
}
