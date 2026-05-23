/**
 * Sanitize an agent's reply before it leaves Brigade for a channel.
 *
 * The model's reasoning trace lives in `<think>…</think>` blocks (the
 * Brigade-emitted contract for non-native-reasoning models — see
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
 * Remove `<think>` reasoning blocks and `<final>` wrappers from `text`. The
 * remaining body is trimmed of edge whitespace introduced by the strip
 * (otherwise WhatsApp messages can start with two blank lines after a long
 * reasoning preamble).
 *
 * Returns the cleaned reply. If stripping leaves nothing behind (the model
 * emitted ONLY reasoning), returns the original text rather than an empty
 * string — better to send something than confuse the recipient with silence.
 */
export function sanitizeReplyForChannel(text: string): string {
	if (!text) return text;
	// `<think>` blocks: dotall match (newlines included). Multiple blocks
	// stripped in one pass. The trailing-whitespace eater removes the blank
	// line the model usually leaves between the block and the answer.
	let out = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
	// `<final>` opening/closing tags — keep the body, drop the wrapper.
	out = out.replace(/<\/?final>\s*/gi, "");
	// Also handle an UNCLOSED `<think>` block (model truncated mid-reasoning):
	// drop from the opening tag to end-of-string so we never leak partial
	// chain-of-thought to a channel recipient.
	out = out.replace(/<think>[\s\S]*$/i, "");
	const trimmed = out.trim();
	// Defensive fallback: if stripping ate everything, send the original so
	// the recipient still gets a reply (better than silence).
	return trimmed.length > 0 ? trimmed : text.trim();
}
