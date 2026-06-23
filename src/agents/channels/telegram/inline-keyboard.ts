/**
 * General Telegram inline-keyboard rendering (NON-approval).
 *
 * Brigade's first inline-button use was approvals only (`approval-native.ts`,
 * whose payloads come from the central approval codec). This module adds the
 * GENERAL case: an agent attaches arbitrary buttons to an outbound message (via
 * the `message_action` `buttons` kind), and the press routes back through the
 * inbound pipeline as a normal turn so the agent can react.
 *
 * A general button's `callback_data` is NOT an approval codec payload — it's a
 * short app-defined token. To keep general presses cleanly separable from
 * approval presses (which the pipeline consumes FIRST), every general payload is
 * namespaced with the {@link GENERAL_CALLBACK_PREFIX}. The pipeline strips the
 * prefix and feeds the remaining token to the agent as a synthetic inbound.
 *
 * SAFETY: Telegram caps `callback_data` at 64 UTF-8 bytes and forbids control
 * bytes; we reuse `sanitizeTelegramCallbackData` and DROP any button whose data
 * doesn't fit the budget after prefixing (rather than ship a truncated token
 * that decodes to the wrong action).
 */

import { GENERAL_CALLBACK_PREFIX } from "../general-callback.js";
import {
	sanitizeTelegramCallbackData,
	TELEGRAM_CALLBACK_DATA_MAX_BYTES,
	TELEGRAM_INTERACTIVE_ROW_SIZE,
	type TelegramInlineButton,
	type TelegramInlineKeyboardMarkup,
} from "./approval-native.js";

/** A general button as the agent specifies it (before prefixing/sanitizing). */
export interface GeneralInlineButtonSpec {
	/** Button label shown to the user. */
	text: string;
	/** App-defined token delivered to the agent on press (≤ ~60 bytes after prefix). */
	data: string;
}

/**
 * Build a general inline keyboard from a grid of button specs. Each button's
 * `data` is prefixed + sanitized; a button whose prefixed data exceeds the
 * 64-byte budget OR whose label is empty is DROPPED. Returns `null` when no
 * usable button remains (the caller then sends a plain message instead).
 */
export function buildTelegramInlineKeyboard(
	grid: GeneralInlineButtonSpec[][],
): TelegramInlineKeyboardMarkup | null {
	const rows: TelegramInlineButton[][] = [];
	for (const specRow of grid) {
		const row: TelegramInlineButton[] = [];
		for (const spec of specRow) {
			const label = (spec?.text ?? "").trim();
			const token = spec?.data ?? "";
			if (!label || !token) continue;
			const prefixed = `${GENERAL_CALLBACK_PREFIX}${token}`;
			// Reject (don't truncate) a token that won't fit — a truncated token
			// would decode to the wrong action on press.
			if (Buffer.byteLength(prefixed, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) continue;
			row.push({ text: label, callback_data: sanitizeTelegramCallbackData(prefixed) });
		}
		if (row.length > 0) rows.push(row);
	}
	if (rows.length === 0) return null;
	// Re-flow into capped rows in case the agent supplied one long row.
	const flat = rows.flat();
	const reflowed: TelegramInlineButton[][] = [];
	const allSingleRows = rows.every((r) => r.length === 1);
	if (allSingleRows && flat.length > TELEGRAM_INTERACTIVE_ROW_SIZE) {
		for (let i = 0; i < flat.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
			reflowed.push(flat.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE));
		}
		return { inline_keyboard: reflowed };
	}
	return { inline_keyboard: rows };
}
