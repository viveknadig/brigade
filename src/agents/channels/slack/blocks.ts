/**
 * Slack Block Kit button rendering + the action_id / value callback codec.
 *
 * Slack's analogue of `telegram/inline-keyboard.ts`. Two button lanes share one
 * builder, exactly as Telegram's do:
 *
 *   - APPROVAL buttons — payloads come from the CENTRAL approval codec
 *     (`buildApprovalCallbackButtons`), so a press resolves through the central
 *     `tryConsumeChannelApprovalCallback`. Built in `approval-native.ts`; this
 *     module only supplies the low-level `actions`-block + button shapes.
 *   - GENERAL buttons — the agent attaches arbitrary buttons via the
 *     `message_action` `buttons` kind; a press routes back through the inbound
 *     pipeline as a normal turn. Every general payload is namespaced with
 *     {@link GENERAL_CALLBACK_PREFIX} so the pipeline can tell it apart from an
 *     approval press (which it consumes FIRST).
 *
 * WHERE THE PAYLOAD RIDES. A Slack button carries BOTH an `action_id` and a
 * `value`. The opaque codec payload rides in `value` (Slack caps it at 255
 * chars — far more generous than Telegram's 64-byte `callback_data`, and the
 * central codec already guarantees ≤64 bytes). The `action_id` is a stable,
 * non-colliding constant ({@link SLACK_APPROVAL_ACTION_ID} /
 * {@link SLACK_GENERAL_ACTION_ID}) so the interactive handler can route the
 * payload without parsing it. A button whose `value` exceeds the cap OR whose
 * label is empty is DROPPED (rather than ship a truncated payload that decodes
 * to the wrong action).
 *
 * Pure / deterministic — no I/O, no globals.
 */

import { GENERAL_CALLBACK_PREFIX } from "../general-callback.js";

/** Slack caps a button's `value` at 2000 chars; we hold to a tight 255 budget. */
export const SLACK_ACTION_VALUE_MAX_CHARS = 255;

/** Slack allows at most 5 elements per `actions` block; group buttons in fives. */
export const SLACK_ACTIONS_BLOCK_MAX = 5;

/** Stable `action_id` an APPROVAL button carries (routes to the approval path). */
export const SLACK_APPROVAL_ACTION_ID = "brigade_approval";

/** Stable `action_id` a GENERAL (agent-attached) button carries. */
export const SLACK_GENERAL_ACTION_ID = "brigade_general";

/** A Slack Block Kit button element (the subset Brigade emits). */
export interface SlackButtonElement {
	type: "button";
	text: { type: "plain_text"; text: string; emoji: boolean };
	/** Routing id — one of the stable `SLACK_*_ACTION_ID` constants. */
	action_id: string;
	/** Opaque codec payload (≤ 255 chars), read back on press. */
	value: string;
	/** Optional visual style (Slack: `primary` green / `danger` red). */
	style?: "primary" | "danger";
}

/** A Slack `actions` block — a row of up to 5 interactive elements. */
export interface SlackActionsBlock {
	type: "actions";
	/** Optional stable id so the block is addressable in the interaction payload. */
	block_id?: string;
	elements: SlackButtonElement[];
}

/** A Slack `section` block carrying mrkdwn text (the prompt body above buttons). */
export interface SlackSectionBlock {
	type: "section";
	text: { type: "mrkdwn"; text: string };
}

/** Any block this module emits (section + actions). */
export type SlackBlock = SlackSectionBlock | SlackActionsBlock;

/** One button spec before it's shaped into a Block Kit element. */
export interface SlackButtonSpec {
	/** Button label shown to the user. */
	text: string;
	/** Opaque codec payload delivered to the handler on press. */
	value: string;
	/** Optional Slack button style. */
	style?: "primary" | "danger";
}

/**
 * Clamp a button value to Slack's budget + strip control bytes. The central
 * codec already guarantees a printable, short payload, so this is purely
 * defensive for a value that didn't come from the codec — and unlike Telegram we
 * never truncate a codec payload (the budget is far larger than the codec's
 * output), we only DROP an over-budget value at the call site.
 */
export function sanitizeSlackActionValue(value: string): string {
	// Drop C0/C1 control chars (incl. NUL) — a button value must be printable.
	// oxlint-disable-next-line no-control-regex
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Shape one button spec into a Block Kit element, or null when it can't fit. */
function toButtonElement(spec: SlackButtonSpec, actionId: string): SlackButtonElement | null {
	const label = (spec?.text ?? "").trim();
	const value = sanitizeSlackActionValue(spec?.value ?? "");
	if (!label || !value) return null;
	// Reject (don't truncate) a value that won't fit — a truncated payload would
	// decode to the wrong action on press.
	if (value.length > SLACK_ACTION_VALUE_MAX_CHARS) return null;
	return {
		type: "button",
		text: { type: "plain_text", text: label.slice(0, 75), emoji: true },
		action_id: actionId,
		value,
		...(spec.style ? { style: spec.style } : {}),
	};
}

/** Group a flat element list into `actions` blocks of at most 5 (Slack's cap). */
function chunkIntoActionBlocks(elements: SlackButtonElement[], blockIdPrefix: string): SlackActionsBlock[] {
	const blocks: SlackActionsBlock[] = [];
	for (let i = 0; i < elements.length; i += SLACK_ACTIONS_BLOCK_MAX) {
		blocks.push({
			type: "actions",
			block_id: `${blockIdPrefix}_${i / SLACK_ACTIONS_BLOCK_MAX}`,
			elements: elements.slice(i, i + SLACK_ACTIONS_BLOCK_MAX),
		});
	}
	return blocks;
}

/**
 * Build the `actions` blocks for an APPROVAL prompt from the central codec's
 * `{ label, data }` specs (the payload rides in `value`). Returns `[]` when
 * fewer than two byte-safe buttons could be shaped — the caller then falls back
 * to a text prompt rather than ship a half-rendered prompt. `Deny` is styled
 * `danger`; the first button `primary`.
 */
export function buildSlackApprovalBlocks(
	specs: ReadonlyArray<{ label: string; data: string; decision?: string }>,
): SlackActionsBlock[] {
	const elements: SlackButtonElement[] = [];
	for (const s of specs) {
		const style: "primary" | "danger" | undefined =
			s.decision === "deny" ? "danger" : s.decision === "allow-once" ? "primary" : undefined;
		const el = toButtonElement({ text: s.label, value: s.data, ...(style ? { style } : {}) }, SLACK_APPROVAL_ACTION_ID);
		if (el) elements.push(el);
	}
	if (elements.length < 2) return []; // not enough buttons → caller uses text prompt
	return chunkIntoActionBlocks(elements, "brigade_approval");
}

/**
 * Build the `actions` blocks for a GENERAL inline keyboard from a grid of button
 * specs. Each spec's `data` is prefixed with {@link GENERAL_CALLBACK_PREFIX} +
 * sanitized; a button whose prefixed value exceeds the budget OR whose label is
 * empty is DROPPED. Returns `null` when no usable button remains (the caller
 * then sends a plain message instead). The grid is flattened + re-chunked into
 * Slack's 5-per-block rows.
 */
export function buildSlackInlineKeyboard(grid: Array<Array<{ text: string; data: string }>>): SlackActionsBlock[] | null {
	const elements: SlackButtonElement[] = [];
	for (const row of grid) {
		for (const spec of row) {
			const label = (spec?.text ?? "").trim();
			const token = spec?.data ?? "";
			if (!label || !token) continue;
			const prefixed = `${GENERAL_CALLBACK_PREFIX}${token}`;
			const el = toButtonElement({ text: label, value: prefixed }, SLACK_GENERAL_ACTION_ID);
			if (el) elements.push(el);
		}
	}
	if (elements.length === 0) return null;
	return chunkIntoActionBlocks(elements, "brigade_general");
}

/** A parsed `block_actions` button press (the subset Brigade reads). */
export interface SlackBlockAction {
	action_id?: string;
	value?: string;
	block_id?: string;
}

/**
 * Pull the opaque codec payload out of a `block_actions` interaction's first
 * Brigade-owned button action. Returns the `value` string the button declared
 * (an approval-codec payload OR a general-prefixed token) so the adapter can
 * stamp it onto `InboundMessage.callbackQuery.data` for the central pipeline to
 * decode — exactly as Telegram surfaces `callback_query.data`. Returns null when
 * no action carried one of our `action_id`s.
 */
export function extractBlockActionPayload(actions: ReadonlyArray<SlackBlockAction> | undefined): string | null {
	if (!Array.isArray(actions)) return null;
	for (const a of actions) {
		if (a?.action_id !== SLACK_APPROVAL_ACTION_ID && a?.action_id !== SLACK_GENERAL_ACTION_ID) continue;
		const value = typeof a.value === "string" ? a.value : "";
		if (value) return value;
	}
	return null;
}
