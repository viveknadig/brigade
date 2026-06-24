/**
 * Discord reasoning-lane split (OPTIONAL, default OFF).
 *
 * Brigade strips `<think>…</think>` reasoning from every channel reply via the
 * shared `sanitizeReplyForChannel` — recipients see only the final answer. For
 * Discord an operator can OPT IN (config `channels.discord.surfaceReasoning:
 * true`) to ALSO receive the reasoning trace as a separate, prefixed message.
 *
 * This module is the pure splitter: given the raw agent reply, it returns
 * `{ reasoningText?, answerText }`. When surfacing is OFF the pipeline never
 * calls this and behavior is byte-identical to today (strip + send answer). When
 * ON, the pipeline sends `reasoningText` first (a `🧠 Reasoning:` block) then the
 * normal sanitized answer.
 *
 * The answer half is computed with the SAME sanitizer the default path uses, so
 * enabling reasoning never changes what the answer message contains — it only
 * ADDS the reasoning message in front.
 *
 * Pure / deterministic / dependency-light (re-uses `sanitizeReplyForChannel`).
 * Discord mirror of `slack/reasoning-lane.ts`.
 */

import { sanitizeReplyForChannel } from "../reply-sanitizer.js";

/** Prefix on the reasoning message so the recipient knows it's the trace. */
export const REASONING_PREFIX = "🧠 Reasoning:\n";

/** Matches a `<think>`/`<thinking>`/`<thought>` open/close tag. */
const THINK_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi;

export interface DiscordReasoningSplit {
	/** The extracted reasoning trace (already prefixed), or undefined when none. */
	reasoningText?: string;
	/** The user-facing answer (sanitized exactly as the default path produces). */
	answerText: string;
}

/**
 * Extract the concatenated text INSIDE `<think>…</think>` blocks. Handles
 * multiple blocks and an unclosed trailing block (model truncated mid-thought).
 * Returns "" when there's no reasoning content.
 */
export function extractReasoning(text: string): string {
	if (!text) return "";
	const parts: string[] = [];
	let inThink = false;
	let lastIndex = 0;
	THINK_TAG_RE.lastIndex = 0;
	for (const match of text.matchAll(THINK_TAG_RE)) {
		const idx = match.index ?? 0;
		const isClose = match[1] === "/";
		if (inThink && isClose) {
			parts.push(text.slice(lastIndex, idx));
			inThink = false;
		} else if (!inThink && !isClose) {
			inThink = true;
			lastIndex = idx + match[0].length;
		}
	}
	// Unclosed trailing block — keep what the model emitted.
	if (inThink) parts.push(text.slice(lastIndex));
	return parts.join("\n").trim();
}

/**
 * Split a raw agent reply into an optional reasoning message + the sanitized
 * answer. The answer is identical to `sanitizeReplyForChannel(raw)`; the
 * reasoning is only populated when a `<think>` block carried content.
 */
export function splitDiscordReasoning(raw: string): DiscordReasoningSplit {
	const answerText = sanitizeReplyForChannel(raw ?? "");
	const reasoning = extractReasoning(raw ?? "");
	if (!reasoning) return { answerText };
	return { reasoningText: `${REASONING_PREFIX}${reasoning}`, answerText };
}
