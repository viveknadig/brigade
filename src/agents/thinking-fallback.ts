/**
 * Thinking-fallback — when the model rejects a turn because the active
 * thinking level isn't supported, silently downgrade to "off" and retry
 * ONCE. The reason this matters in practice:
 *
 *   - Static capability inference (`model.reasoning` flag in Pi's catalog)
 *     can be WRONG. Ollama doesn't report capabilities — we infer from the
 *     model name. `qwen3-coder` looks like qwen3-family (which has
 *     reasoning) but the coder variant is text-only.
 *   - OpenRouter / aggregator-prefixed models route through different
 *     backends per slug. Pi's flag may say "yes thinking" but the actual
 *     route may be a model that doesn't expose thinking. The error fires
 *     at runtime; the static catalog never sees it.
 *
 * Without this wrapper, every wrong guess = a hard failure for the user.
 * One retry-with-thinking=off is enough to recover the common cases.
 *
 * Hard-capped at one retry — if the second attempt also fails, the error
 * propagates normally (caller's model-fallback layer can rotate
 * candidates from there).
 *
 * Ported from `core/agent.ts:1319-1371` (Runtime A) — same logic.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Detector for the family of "thinking not supported" error messages
 * across providers. Conservative — false positives just trigger an
 * extra retry on a model we'd have failed anyway, which is fine.
 *
 * Patterns observed across Anthropic / Gemini / Ollama / OpenRouter
 * routes that ended up at non-reasoning models.
 */
export function looksLikeThinkingNotSupported(message: string): boolean {
	if (!message) return false;
	return /not support(?:ed)? (?:extended )?thinking|thinking is not enabled|thinking_config|does not allow thinking|requires thinking_off/i.test(
		message,
	);
}

/**
 * Pull the error message off the last assistant turn IFF it ended with
 * `stopReason === "error"`. Returns undefined for healthy turns.
 *
 * Pi sets `errorMessage` on the assistant message object when the turn
 * fails partway through — that's what we inspect to decide whether to
 * downgrade and retry.
 */
function lastAssistantErrorMessage(session: AgentSession): string | undefined {
	const last = [...session.messages]
		.reverse()
		.find((m: { role?: string }) => m.role === "assistant");
	if (!last) return undefined;
	const stop = (last as { stopReason?: unknown }).stopReason;
	const errMsg = (last as { errorMessage?: unknown }).errorMessage;
	if (stop !== "error" || typeof errMsg !== "string") return undefined;
	return errMsg;
}

export interface ThinkingFallbackOptions {
	/** Called just before the auto-downgrade retry. */
	onDowngrade?: (originalLevel: string, errorMessage: string) => void;
}

/**
 * Run a prompt body. If the model rejects with "doesn't support
 * thinking", downgrade `thinkingLevel` to "off" and retry once with the
 * same user message.
 *
 * Re-extracts the last user message from session history because Pi
 * doesn't expose the user's input as a return value from `prompt()` —
 * the prompt is queued and the function settles on the assistant
 * response.
 */
export async function runWithThinkingFallback(
	session: AgentSession,
	body: () => Promise<void>,
	options: ThinkingFallbackOptions = {},
): Promise<void> {
	await body();

	const errMsg = lastAssistantErrorMessage(session);
	if (!errMsg || !looksLikeThinkingNotSupported(errMsg)) return;
	// Already on off — retry would loop.
	if (session.thinkingLevel === "off") return;

	const originalLevel = session.thinkingLevel;
	options.onDowngrade?.(originalLevel, errMsg);
	session.setThinkingLevel("off");

	// Retry once with thinking off. Re-prompt with the same user
	// message — we extract from session history.
	const lastUser = [...session.messages]
		.reverse()
		.find((m: { role?: string }) => m.role === "user");
	if (!lastUser) return;

	const content = (lastUser as { content?: unknown }).content;
	if (!Array.isArray(content)) return;
	const text = content
		.filter(
			(b) =>
				b && typeof b === "object" && (b as { type?: unknown }).type === "text"
				&& typeof (b as { text?: unknown }).text === "string",
		)
		.map((b) => (b as { text: string }).text)
		.join("");
	if (!text) return;

	await session.prompt(text);
}
