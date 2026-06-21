/**
 * UTF-16 surrogate sanitization — strip lone (unpaired) high/low
 * surrogate code units from text BEFORE they reach a JSON encoder.
 *
 * Why: Pi sends messages to providers as JSON. JSON.stringify happily
 * emits `\uD800` for a lone high surrogate, but Anthropic / OpenAI's
 * intake reject the payload as malformed UTF-8 ("Invalid Unicode
 * escape" or 400 "lone surrogate"). The most common source is bash
 * tool output that was tail-truncated mid-character — splits a
 * 4-byte UTF-8 codepoint across the boundary and leaves a half.
 *
 * Two-pass strip:
 *   1. High surrogate (D800-DBFF) NOT followed by a low → strip
 *   2. Low surrogate (DC00-DFFF) NOT preceded by a high → strip
 *
 * Valid surrogate PAIRS are preserved. Only LONE halves get removed.
 *
 * Ported from `core/agent.ts:998-1031` (Runtime A).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function sanitizeSurrogates(text: string): string {
	if (!text) return text;
	return text
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Walk an `AgentMessage[]` and sanitize lone surrogates from every
 * `text` and `thinking` content block. Returns a NEW array — input is
 * not mutated.
 *
 * Wired via `transformContext` so every LLM call sees clean UTF-16.
 */
export function sanitizeMessages(messages: AgentMessage[]): AgentMessage[] {
	if (!Array.isArray(messages)) return messages;
	return messages.map((msg) => {
		const m = msg as { content?: unknown };
		if (!m || !Array.isArray(m.content)) return msg;
		const cleanedContent = m.content.map((block) => {
			if (!block || typeof block !== "object") return block;
			const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
			if (b.type === "text" && typeof b.text === "string") {
				return { ...b, text: sanitizeSurrogates(b.text) };
			}
			if (b.type === "thinking" && typeof b.thinking === "string") {
				return { ...b, thinking: sanitizeSurrogates(b.thinking) };
			}
			return block;
		});
		return { ...m, content: cleanedContent };
	}) as AgentMessage[];
}
