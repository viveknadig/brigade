/**
 * Pure transcript-projection helpers for the connect TUI's reliable-streaming
 * renderer. Extracted from `connect.ts` so the identity-key + message-text
 * logic is unit-testable without driving Pi-TUI (the suite convention — see
 * `connect.test.ts`, which exercises pure helpers directly).
 *
 * No brand / chalk / widget coupling: these return raw keys + strings; the
 * caller wraps them in Pi-TUI widgets and colour, and applies the terminal
 * escape scrub (`scrubRenderable`) between joining and clipping tool output.
 */

/**
 * Identity key for an assistant message's render block: `${depth}:${timestamp}`.
 *
 * Pi stamps each assistant message with a stable `timestamp` at creation that
 * is constant across all of its `message_update`s and its `message_end`, and a
 * NEW message (e.g. the continuation after a tool call) gets a NEW timestamp.
 * So one logical message owns exactly one block — a block lands where its
 * message belongs in the stream (never above a tool it came after), a
 * late/duplicate update resolves to its own block instead of spawning a copy,
 * and re-applying a message on `resume` is idempotent. `depth` keeps sub-agent
 * (≥1) streams from colliding with the top-level (0) stream. Falls back to
 * `"live"` only if a message somehow lacks a timestamp (shouldn't happen — the
 * field is required on Pi messages).
 */
export function asstKey(depth: number, msg: { timestamp?: number } | null | undefined): string {
	return `${depth}:${typeof msg?.timestamp === "number" ? msg.timestamp : "live"}`;
}

/** Plain text of a user message (string content, or the text blocks of an
 *  array content). Returns "" for anything else. */
export function extractUserText(msg: { content?: unknown } | null | undefined): string {
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text as string)
			.join("");
	}
	return "";
}

/** Concatenate the text blocks of a toolResult message's content into one raw
 *  string (string content passes through). Caller scrubs + clips. */
export function joinToolResultText(content: unknown): string {
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text as string)
			.join(" ");
	}
	return typeof content === "string" ? content : "";
}

/** Collapse whitespace, trim, and clip to `maxLen` with an ellipsis — for the
 *  one-line tool-result preview shown next to the ✓/✗ indicator. */
export function clipOneLine(text: string, maxLen = 80): string {
	const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
	return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}
