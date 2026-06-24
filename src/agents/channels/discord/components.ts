/**
 * Discord message-component button rendering + the custom_id callback codec.
 *
 * Discord's analogue of `slack/blocks.ts`. Two button lanes share one builder,
 * exactly as Slack's do:
 *
 *   - APPROVAL buttons — payloads come from the CENTRAL approval codec
 *     (`buildApprovalCallbackButtons`), so a press resolves through the central
 *     `tryConsumeChannelApprovalCallback`. Built in `approval-native.ts`; this
 *     module only supplies the low-level row + button shapes.
 *   - GENERAL buttons — the agent attaches arbitrary buttons via the
 *     `message_action` `buttons` kind; a press routes back through the inbound
 *     pipeline as a normal turn. Every general payload is namespaced with
 *     {@link GENERAL_CALLBACK_PREFIX} so the pipeline can tell it apart from an
 *     approval press (which it consumes FIRST).
 *
 * WHERE THE PAYLOAD RIDES. A Discord button carries its opaque codec payload in
 * `custom_id` (Discord caps it at 100 chars). The central approval codec already
 * guarantees ≤64 UTF-8 bytes, so an approval payload always fits; a general
 * payload that exceeds the budget after prefixing is DROPPED (rather than ship a
 * truncated id that decodes to the wrong action on press). On press, discord.js
 * delivers the pressed `interaction.customId` verbatim, which the central
 * pipeline decodes — there is no separate routing id (unlike Slack's action_id).
 *
 * These builders emit PLAIN serializable specs (a `DiscordButtonSpec` grid); the
 * connection turns each into a discord.js `ActionRowBuilder<ButtonBuilder>` at
 * send time, so this module stays pure + dependency-light + unit-testable
 * without importing discord.js.
 *
 * Pure / deterministic — no I/O, no globals.
 */

import { GENERAL_CALLBACK_PREFIX } from "../general-callback.js";

/** Discord caps a component `custom_id` at 100 chars. */
export const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

/** Discord allows at most 5 buttons per action row. */
export const DISCORD_BUTTONS_PER_ROW = 5;

/** Discord allows at most 5 action rows per message. */
export const DISCORD_MAX_ROWS = 5;

/** Discord button label cap (chars). */
const DISCORD_BUTTON_LABEL_MAX = 80;

/** Discord ButtonStyle enum values (mirrors discord.js `ButtonStyle`). */
export const DISCORD_BUTTON_STYLE = {
	Primary: 1,
	Secondary: 2,
	Success: 3,
	Danger: 4,
} as const;

export type DiscordButtonStyleValue = (typeof DISCORD_BUTTON_STYLE)[keyof typeof DISCORD_BUTTON_STYLE];

/** A single serializable Discord button spec (the connection turns it into a ButtonBuilder). */
export interface DiscordButtonSpec {
	/** Button label shown to the user (≤ 80 chars). */
	label: string;
	/** Opaque codec payload carried in `custom_id` (≤ 100 chars), read back on press. */
	customId: string;
	/** Discord button style (default Secondary). */
	style: DiscordButtonStyleValue;
}

/** One action row — up to 5 buttons. */
export type DiscordActionRow = DiscordButtonSpec[];

/** One button spec before it's shaped + validated. */
export interface DiscordButtonInput {
	/** Button label shown to the user. */
	text: string;
	/** Opaque codec payload delivered to the handler on press. */
	value: string;
	/** Optional Discord button style. */
	style?: DiscordButtonStyleValue;
}

/**
 * Strip control bytes from a custom_id. The central codec already guarantees a
 * printable, short payload, so this is purely defensive for a value that didn't
 * come from the codec — and we never truncate a payload (we DROP an over-budget
 * one at the call site), since a truncated id would decode to the wrong action.
 */
export function sanitizeDiscordCustomId(value: string): string {
	// oxlint-disable-next-line no-control-regex
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Shape one button input into a validated spec, or null when it can't fit. */
function toButton(input: DiscordButtonInput): DiscordButtonSpec | null {
	const label = (input?.text ?? "").trim();
	const customId = sanitizeDiscordCustomId(input?.value ?? "");
	if (!label || !customId) return null;
	// Reject (don't truncate) an id that won't fit — a truncated payload would
	// decode to the wrong action on press.
	if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) return null;
	return {
		label: label.slice(0, DISCORD_BUTTON_LABEL_MAX),
		customId,
		style: input.style ?? DISCORD_BUTTON_STYLE.Secondary,
	};
}

/** Group a flat button list into rows of at most 5, capped at 5 rows total. */
function chunkIntoRows(buttons: DiscordButtonSpec[]): DiscordActionRow[] {
	const rows: DiscordActionRow[] = [];
	for (let i = 0; i < buttons.length && rows.length < DISCORD_MAX_ROWS; i += DISCORD_BUTTONS_PER_ROW) {
		rows.push(buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW));
	}
	return rows;
}

/**
 * Build the action rows for an APPROVAL prompt from the central codec's
 * `{ label, data, decision }` specs (the payload rides in `custom_id`). Returns
 * `[]` when fewer than two byte-safe buttons could be shaped — the caller then
 * falls back to a text prompt rather than ship a half-rendered prompt. `Deny` is
 * styled Danger; the first (allow-once) button Success.
 */
export function buildDiscordApprovalRows(
	specs: ReadonlyArray<{ label: string; data: string; decision?: string }>,
): DiscordActionRow[] {
	const buttons: DiscordButtonSpec[] = [];
	for (const s of specs) {
		const style: DiscordButtonStyleValue =
			s.decision === "deny"
				? DISCORD_BUTTON_STYLE.Danger
				: s.decision === "allow-once"
					? DISCORD_BUTTON_STYLE.Success
					: DISCORD_BUTTON_STYLE.Secondary;
		const btn = toButton({ text: s.label, value: s.data, style });
		if (btn) buttons.push(btn);
	}
	if (buttons.length < 2) return []; // not enough buttons → caller uses text prompt
	return chunkIntoRows(buttons);
}

/**
 * Build the action rows for a GENERAL button keyboard from a grid of specs. Each
 * spec's `data` is prefixed with {@link GENERAL_CALLBACK_PREFIX} + sanitized; a
 * button whose prefixed id exceeds the budget OR whose label is empty is
 * DROPPED. Returns `null` when no usable button remains (the caller then sends a
 * plain message instead). The grid is flattened + re-chunked into Discord's
 * 5-per-row / 5-row limits.
 */
export function buildDiscordButtonRows(grid: Array<Array<{ text: string; data: string }>>): DiscordActionRow[] | null {
	const buttons: DiscordButtonSpec[] = [];
	for (const row of grid) {
		for (const spec of row) {
			const label = (spec?.text ?? "").trim();
			const token = spec?.data ?? "";
			if (!label || !token) continue;
			const prefixed = `${GENERAL_CALLBACK_PREFIX}${token}`;
			const btn = toButton({ text: label, value: prefixed });
			if (btn) buttons.push(btn);
		}
	}
	if (buttons.length === 0) return null;
	return chunkIntoRows(buttons);
}
