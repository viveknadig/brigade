/**
 * iMessage outbound-addressing adapter (the `ChannelPlugin.messaging` slot).
 *
 * Turns the loose `to` the agent hands `send_message` ("+1 555 123 4567",
 * "imessage:user@example.com", "chat_id:42") into a concrete target the runtime
 * `sendText` understands. iMessage has no contact DIRECTORY (no name→id
 * resolution), so this implements only the required `parseExplicitTarget` +
 * `normalizeTarget` (+ advisory `inferTargetChatType`); a bare human name falls
 * through to the raw id, exactly as before.
 */

import type { ChannelMessagingAdapter, ParsedExplicitTarget } from "../sdk.js";
import {
	inferIMessageTargetChatType,
	looksLikeIMessageTargetId,
	normalizeIMessageHandle,
} from "./targets.js";

/** The iMessage messaging adapter. */
export const imessageMessagingAdapter: ChannelMessagingAdapter = {
	parseExplicitTarget(text: string): ParsedExplicitTarget | null {
		const trimmed = (text ?? "").trim();
		if (!trimmed) return null;
		// An explicit `imessage:<handle>` form names the channel.
		const m = /^imessage:(.+)$/i.exec(trimmed);
		if (m && m[1]) return { channelId: "imessage", target: m[1].trim() };
		// A concrete chat/service/handle id (vs a bare name) is an explicit target.
		if (looksLikeIMessageTargetId(trimmed)) return { target: trimmed };
		return null;
	},
	normalizeTarget(raw: string): string {
		const trimmed = (raw ?? "").trim();
		if (!trimmed) return trimmed;
		return normalizeIMessageHandle(trimmed);
	},
	inferTargetChatType(target: string): "dm" | "group" | undefined {
		return inferIMessageTargetChatType(target);
	},
};
