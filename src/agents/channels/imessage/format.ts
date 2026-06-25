/**
 * iMessage outbound formatting helpers.
 *
 * iMessage has NO rich markup — a message is plain text. So unlike Telegram
 * (HTML) or Discord (CommonMark), the only transform we need is to make markdown
 * READABLE as plain text:
 *   - a markdown pipe-table is flattened to `cell | cell` lines (the LLM emits
 *     tables and an un-flattened one renders as raw `| --- |` noise);
 *   - everything else passes through untouched (bold `**x**`, links `[a](b)` —
 *     iMessage shows the literal characters, which is the honest fallback).
 *
 * Plus two send-path utilities ported from the upstream `send.ts`:
 *   - `sanitizeReplyToId` — scrub a reply-to id of control chars / brackets so it
 *     can't break the bridge's tag parsing, capped at 256 chars;
 *   - `resolveDeliveredText` — when an outbound has media but no text, deliver a
 *     `<media:kind>` placeholder so the echo cache + transcript have a body.
 */

/** Max length of a sanitized reply-to id. */
const MAX_REPLY_TO_ID_LENGTH = 256;

/**
 * Flatten a markdown pipe-table block into plain `cell | cell` lines, dropping
 * the `|---|` separator row. A non-table block is returned unchanged.
 */
function flattenTableBlock(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		// Drop the header separator row (`| --- | --- |`).
		if (/^\|?\s*:?-{2,}.*\|/.test(trimmed) && /^[\s|:-]+$/.test(trimmed)) continue;
		const cells = trimmed
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((c) => c.trim());
		out.push(cells.join(" | "));
	}
	return out;
}

/** True when a line looks like a markdown table row (`| a | b |`). */
function isTableRow(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && t.includes("|", 1);
}

/**
 * Convert agent-style markdown to iMessage-friendly plain text. The only
 * load-bearing transform is flattening pipe tables; all other markdown passes
 * through verbatim (iMessage renders the literal characters).
 */
export function markdownToIMessageText(markdown: string): string {
	const src = markdown ?? "";
	if (!src.includes("|")) return src; // fast path — no table possible
	const lines = src.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (isTableRow(lines[i] ?? "")) {
			const start = i;
			while (i < lines.length && isTableRow(lines[i] ?? "")) i++;
			out.push(...flattenTableBlock(lines.slice(start, i)));
			continue;
		}
		out.push(lines[i] ?? "");
		i++;
	}
	return out.join("\n");
}

/** Strip control chars + `[` / `]` so a reply id can't break the bridge's tags. */
function stripUnsafeReplyTagChars(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code <= 31 || code === 127) continue;
		if (ch === "[" || ch === "]") continue;
		out += ch;
	}
	return out;
}

/**
 * Sanitize an outbound reply-to id: trim, strip unsafe chars, cap at 256 chars.
 * Returns undefined when nothing usable remains.
 */
export function sanitizeReplyToId(raw?: string): string | undefined {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return undefined;
	let v = stripUnsafeReplyTagChars(trimmed).trim();
	if (!v) return undefined;
	if (v.length > MAX_REPLY_TO_ID_LENGTH) v = v.slice(0, MAX_REPLY_TO_ID_LENGTH);
	return v;
}

/** Outbound media kind → the placeholder text used when the message has no body. */
export type IMessageMediaKind = OutboundMediaKind;
type OutboundMediaKind = "image" | "video" | "audio" | "voice" | "document" | "sticker";

/**
 * When an outbound carries media but no text, deliver a `<media:kind>`
 * placeholder so the echo cache + transcript have a body to key on. Returns the
 * text unchanged when it's non-empty.
 */
export function resolveDeliveredText(text: string, mediaKind?: OutboundMediaKind): string {
	if ((text ?? "").trim()) return text;
	if (!mediaKind) return text;
	return `<media:${mediaKind}>`;
}
