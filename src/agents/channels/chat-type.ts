/**
 * Per-conversation chat-kind discriminator + canonicaliser.
 *
 * Brand-scrubbed analogue of the upstream `src/channels/chat-type.ts`.
 *
 * Three values cover every messaging surface Brigade routes through:
 *   - `direct`  → one-to-one DM (WhatsApp DM, Slack DM, Telegram private)
 *   - `group`   → multi-party room (WhatsApp group, Telegram group, Slack channel
 *                 when used room-style without threading)
 *   - `channel` → broadcast / topic-style room (Telegram channel, Slack
 *                 channels intended for broadcast, Discord forum topic)
 *
 * Brigade's existing `InboundMessage.chatType` field is the narrower
 * `"direct" | "group"` union — the broader `ChatType` here is a
 * superset that the route resolver + session-key builder use to
 * represent every adapter's surface (Brigade extends to "channel" when
 * channel adapters that need it land — see Step 16).
 */

import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";

export type ChatType = "direct" | "group" | "channel";

/**
 * Coerce a loose string into the canonical `ChatType` enum, or return
 * `undefined` when the input doesn't map. Accepts lower / mixed case
 * and trims whitespace. Anything outside the three allowed values
 * returns `undefined`.
 */
export function normalizeChatType(value: unknown): ChatType | undefined {
	const lowered = normalizeOptionalLowercaseString(value);
	if (lowered === "direct" || lowered === "group" || lowered === "channel") {
		return lowered;
	}
	return undefined;
}
