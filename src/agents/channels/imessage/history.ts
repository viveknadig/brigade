/**
 * iMessage rolling group-history context.
 *
 * iMessage delivers ONE `imsg rpc` notification per new message with no thread
 * context — so when an untagged group message arrives, the agent has no idea
 * what the room was just talking about. Unlike BlueBubbles (which exposes an
 * HTTP message-listing endpoint), the `imsg rpc` transport exposes NO history /
 * `chats.messages` method (its only calls are `chats.list`, `send`,
 * `watch.subscribe`). So — exactly as the upstream iMessage monitor does — we
 * keep a small ROLLING in-memory buffer of the last N text-bearing messages
 * we've already seen per conversation, and prepend them as a fenced
 * `[recent conversation context]` block to an untagged message's body.
 *
 * The buffer is bounded (`limit` entries per conversation) and the message the
 * context is built FOR is appended only AFTER its block is rendered, so a
 * message never quotes itself.
 */

/** One compact rolling-history line. */
export interface IMessageHistoryEntry {
	/** Display label of the speaker (handle / name, or "me" for the bot's own past sends). */
	sender: string;
	/** Message text (truncated). */
	body: string;
}

/** Cap on a single history line's length (keeps the context block bounded). */
const MAX_HISTORY_BODY_CHARS = 2_000;
/** Hard ceiling on entries retained per conversation regardless of `limit`. */
const MAX_HISTORY_ENTRIES = 100;

/** Truncate a history line body, marking the cut. */
function truncateBody(text: string): string {
	const t = text.trim();
	if (t.length <= MAX_HISTORY_BODY_CHARS) return t;
	return `${t.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}

/**
 * Per-account rolling buffer of recent messages, keyed by conversation id. Pure
 * in-memory (no I/O); one instance lives in each connection's closure.
 */
export class IMessageHistoryBuffer {
	private readonly byConversation = new Map<string, IMessageHistoryEntry[]>();

	/**
	 * Return the last `limit` entries for `conversationId` (oldest-first), rendered
	 * to the caller. Returns [] when nothing is buffered or `limit <= 0`.
	 */
	recent(conversationId: string, limit: number): IMessageHistoryEntry[] {
		if (limit <= 0) return [];
		const arr = this.byConversation.get(conversationId);
		if (!arr || arr.length === 0) return [];
		return arr.slice(-limit);
	}

	/**
	 * Append a seen message to the conversation's buffer (empty bodies are
	 * ignored). The buffer is trimmed to `MAX_HISTORY_ENTRIES`.
	 */
	record(conversationId: string, entry: IMessageHistoryEntry): void {
		const body = truncateBody(entry.body ?? "");
		if (!body) return;
		const arr = this.byConversation.get(conversationId) ?? [];
		arr.push({ sender: entry.sender || "Unknown", body });
		while (arr.length > MAX_HISTORY_ENTRIES) arr.shift();
		this.byConversation.set(conversationId, arr);
	}
}

/**
 * Render rolling-history entries as a clearly-fenced context block to PREPEND to
 * an inbound body. Returns "" when there are no entries. The block is delimited
 * so the agent can tell prior context from the current message. Mirrors
 * BlueBubbles' `renderBlueBubblesHistoryBlock`.
 */
export function renderIMessageHistoryBlock(entries: IMessageHistoryEntry[]): string {
	if (!entries || entries.length === 0) return "";
	const lines = entries.map((e) => `${e.sender}: ${e.body}`);
	return ["[recent conversation context]", ...lines, "[end context]"].join("\n");
}
