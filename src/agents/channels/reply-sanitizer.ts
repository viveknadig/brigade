/**
 * Sanitize an agent's reply before it leaves Brigade for a channel.
 *
 * The model's reasoning trace lives in `<think>…</think>` blocks (Brigade's
 * emission contract for non-native-reasoning models — see
 * `system-prompt/guidance.ts`). For the TUI we render those blocks in a folded
 * panel; for channels (WhatsApp, Slack, Telegram, …) we strip them entirely.
 * Recipients see only the final answer — no XML tags, no internal monologue,
 * no leaked planning.
 *
 * Also strips a `<final>` outer wrapper when the model emits one (some
 * `<think>+<final>` style outputs use it as a sibling tag). The body of
 * `<final>` is kept; only the tags themselves are removed so we never lose
 * user-visible text.
 *
 * Pure / deterministic / dependency-free — tested as a unit.
 */

/**
 * Iteratively strip every fully-closed `<think>…</think>` block (innermost
 * first, so a deeply nested pair like `<think><think>x</think></think>` is
 * fully consumed in two passes rather than leaving an orphan close tag).
 *
 * Uses a manual scan rather than `.replace(/…/g)` because a global non-greedy
 * regex over nested tags leaves the outer close tag behind on the first pass —
 * we need to keep reducing until the input stops changing.
 */
function stripClosedThinkBlocks(text: string): string {
	let out = text;
	// Hard upper bound on iterations defends against pathological inputs that
	// somehow defeat the fixed-point check (shouldn't happen — every iteration
	// either removes a `<think>` or breaks). Keeps this function strictly O(n).
	for (let i = 0; i < 32; i++) {
		const next = out.replace(/<think>[^<]*?<\/think>\s*/i, "");
		if (next === out) {
			// Inner-most-only didn't match; try the dotall version (which CAN
			// span newlines AND any non-`<think>` content). This handles a
			// flat `<think>multi\nline</think>` block in one shot. For TRUE
			// nesting it would still match outer-first and leave debris, so
			// we wrap this in the same fixed-point loop.
			const dotall = out.replace(/<think>(?:(?!<think>)[\s\S])*?<\/think>\s*/i, "");
			if (dotall === out) return out;
			out = dotall;
		} else {
			out = next;
		}
	}
	return out;
}

/**
 * Remove `<think>` reasoning blocks and `<final>` wrappers from `text`. The
 * remaining body is trimmed of edge whitespace introduced by the strip
 * (otherwise WhatsApp messages can start with two blank lines after a long
 * reasoning preamble).
 *
 * Edge cases:
 *  - Nested `<think>` blocks are stripped iteratively so the outer close tag
 *    doesn't leak into the channel reply.
 *  - An UNCLOSED `<think>` block (model truncated mid-reasoning) is stripped
 *    from the opening tag onward — BUT ONLY when no `</think>` appears later
 *    in the text. Otherwise the unclosed-strip would destroy legitimate
 *    replies that mention the literal substring `<think>` (e.g. a question
 *    about the HTML element).
 *
 * Returns the cleaned reply. If stripping leaves nothing behind (the model
 * emitted ONLY reasoning), returns the original text rather than an empty
 * string — better to send something than confuse the recipient with silence.
 */
export function sanitizeReplyForChannel(text: string): string {
	if (!text) return text;
	// First pass: drain every fully-closed `<think>…</think>` (handles nesting).
	let out = stripClosedThinkBlocks(text);
	// `<final>` opening/closing tags — keep the body, drop the wrapper.
	out = out.replace(/<\/?final>\s*/gi, "");
	// Unclosed-`<think>` strip — only when it's clearly a model emission,
	// never when it's the user/bot mentioning the literal tag name. The
	// safest signal: the model's reasoning format puts `<think>` at the
	// VERY START of the reply (see system-prompt-guidance.ts). A literal
	// mention ("Tell me about the <think> tag") appears mid-sentence. So
	// we only strip when the trimmed remaining text begins with `<think>`.
	const trimmedHead = out.trimStart();
	if (/^<think>/i.test(trimmedHead) && !/<\/think>/i.test(trimmedHead)) {
		// Reasoning emission was truncated mid-stream and never closed —
		// drop the lot (the model produced no final answer to send).
		out = "";
	}
	const trimmed = out.trim();
	// Defensive fallback: if stripping ate everything, send the original so
	// the recipient still gets a reply (better than silence).
	return trimmed.length > 0 ? trimmed : text.trim();
}
