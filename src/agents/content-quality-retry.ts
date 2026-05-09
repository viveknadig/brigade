/**
 * Content-quality retry — detects "model said it would act but didn't" /
 * "model returned reasoning but no visible reply" / "model returned empty"
 * after a turn settles, then re-prompts ONCE with a tailored steering
 * message.
 *
 * Why one-shot: this wrapper composes with model-fallback + retry-policy
 * + stream-wrappers. Without a hard cap, a pathological turn could chain
 * 4-6 prompts. One retry is enough to recover the common cases (most
 * smaller models follow the steer on the second attempt).
 *
 * Three failure modes:
 *   - **empty** — no content blocks at all
 *   - **reasoning-only** — thinking blocks present but no visible text
 *     OR tool call (the user sees a blank reply)
 *   - **planning-only** — text matches a "I'll do X" pattern AND no tool
 *     was invoked. Only flagged when tools are actually available.
 *
 * Ported from `core/agent.ts:1140-1248` (Runtime A) — same logic, no
 * functional change. Lives here so Runtime B can call it without
 * importing from Runtime A.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

export type ContentQualityIssue = "empty" | "reasoning-only" | "planning-only" | null;

/**
 * Sentence-start anchor — `(?:^|[.!?\n]\s+)`. Used by every planning-phrase
 * pattern below so the matcher fires only when the phrase opens a sentence,
 * not when it appears inside a quoted user message ("the user said 'I'll
 * fix it' which means..."). Without this anchor, the assistant echoing
 * the user's own intent would falsely trigger a retry.
 */
const SENTENCE_START = "(?:^|[.!?\\n]\\s+)";

const PLANNING_PHRASES = [
	new RegExp(
		`${SENTENCE_START}i'?ll (?:create|write|build|make|generate|set up|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`,
		"i",
	),
	new RegExp(
		`${SENTENCE_START}let me (?:create|write|build|make|generate|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`,
		"i",
	),
	new RegExp(
		`${SENTENCE_START}(?:going to|i will|i shall) (?:create|write|build|make|generate|implement)`,
		"i",
	),
	new RegExp(`${SENTENCE_START}here'?s (?:what|how) i'?ll`, "i"),
];

const STEER_FOR: Record<NonNullable<ContentQualityIssue>, string> = {
	empty:
		"You returned no visible reply. Provide your full visible answer to the user's last message now, in plain text.",
	"reasoning-only":
		"You produced reasoning but no visible answer. Provide your final visible answer to the user now, in plain text outside of any reasoning blocks.",
	"planning-only":
		"You described an action you would take, but you did not actually invoke the tool to do it. Take the action now using the appropriate tool — do not just describe it again.",
};

/**
 * Inspect an assistant message for low-quality content. Returns the
 * issue type or null. Public for tests; the wrapper below calls it.
 *
 * `hadTools` should be `true` when the session has tools registered —
 * planning-only is only meaningful in that case (without tools, "I'll
 * write the code" IS the deliverable).
 */
export function detectContentIssue(
	message: { role?: string; content?: unknown } | null | undefined,
	hadTools: boolean,
): ContentQualityIssue {
	if (!message || message.role !== "assistant") return null;
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return "empty";

	const textBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text"
			&& typeof (b as { text?: unknown }).text === "string",
	);
	const thinkingBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "thinking",
	);
	const toolCallBlocks = content.filter(
		(b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall",
	);

	const totalText = textBlocks
		.map((b) => (b as { text: string }).text)
		.join("")
		.trim();

	// Reasoning-only: had thinking blocks, no text, no tool call.
	if (thinkingBlocks.length > 0 && totalText.length === 0 && toolCallBlocks.length === 0) {
		return "reasoning-only";
	}

	// Empty: zero text AND zero tool calls (and not reasoning-only above).
	if (totalText.length === 0 && toolCallBlocks.length === 0) return "empty";

	// Planning-only: only matters when tools were available — otherwise the
	// model has no choice. We check that the text matches a planning phrase
	// AND no tool was invoked in this final message.
	if (hadTools && toolCallBlocks.length === 0 && totalText.length > 0) {
		if (PLANNING_PHRASES.some((re) => re.test(totalText))) return "planning-only";
	}

	return null;
}

export interface ContentQualityRetryOptions {
	/** Called when a retry is triggered, with the detected reason. */
	onRetry?: (reason: NonNullable<ContentQualityIssue>) => void;
}

/**
 * Run a prompt body. After it resolves, inspect the final assistant
 * message for low-quality content. If detected, queue a steering
 * message and re-run ONCE.
 *
 * Hardcoded cap of one retry — by control flow, not configuration.
 * Composes with other retry layers (model-fallback, retry-policy,
 * thinking-fallback) without compounding the budget.
 *
 * The retry is a fresh `session.prompt()` with the steer text — NOT a
 * provider-specific prefill. More tokens, but provider-portable in v1.
 */
export async function runWithContentQualityRetry(
	session: AgentSession,
	body: () => Promise<void>,
	options: ContentQualityRetryOptions = {},
): Promise<void> {
	await body();

	// Snapshot session state immediately so async subscribers can't mutate
	// what we're inspecting. Race window without the snapshot: between
	// body() resolving and detectContentIssue() running, another event
	// listener (extension hook, telemetry handler) could append a
	// message — making "last assistant" be something other than what
	// body() actually produced.
	const snapshot = [...session.messages];
	const tools = (session.agent.state as { tools?: unknown }).tools;
	const hadTools = Array.isArray(tools) && tools.length > 0;

	const lastAssistant = [...snapshot]
		.reverse()
		.find((m: { role?: string }) => m.role === "assistant");
	const issue = detectContentIssue(lastAssistant, hadTools);
	if (!issue) return;

	options.onRetry?.(issue);

	// Queue the steer message as a normal user prompt — we re-prompt
	// directly here (Pi's `agent.steer` is for mid-turn injection; this
	// fires AFTER the turn ended). The steer text addresses the specific
	// failure mode.
	await session.prompt(STEER_FOR[issue]);
}
