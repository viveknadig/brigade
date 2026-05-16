/**
 * System-prompt guidance constants.
 *
 * Two always-on blocks live HERE (the rest moved inline to assembler.ts
 * so they're easier to keep in sync with OpenClaw's exact text):
 *
 *   - `REASONING_FORMAT_GUIDANCE` — `<think>` tag rules, conditional on
 *     model + thinking-level via `shouldUseReasoningFormat`.
 *   - `OPENAI_FAMILY_GUIDANCE` / `GOOGLE_FAMILY_GUIDANCE` — per-model-
 *     family identity-override blocks, picked via `pickModelFamilyGuidance`.
 *     These are Brigade-better than OpenClaw (which has no equivalent);
 *     gpt-5 / gemini-2.5 routinely identify as "ChatGPT" / "Gemini" until
 *     overridden, which is a real multi-provider failure mode.
 *
 * Three conditional blocks remain DEFINED-BUT-UNWIRED, waiting for the
 * matching primitives to ship (Memory = #4, Skills = #5, Sub-agents = #6).
 * Each is wired into the assembler via the `capabilities` AssembleArgs
 * field the moment its primitive lands — the bodies stay close to the
 * model's mental model of the feature so they don't drift apart.
 *
 * Naming rule: zero references to other agent projects. Patterns are
 * lifted (memory discipline, family overrides) but every identifier and
 * word here is Brigade-native.
 */

/* ───────────────── Reasoning format (conditional on thinking) ───────────────── */

/**
 * Tag-based reasoning isolation for models that don't have first-class
 * extended thinking. Wired by `assembler.ts` whenever
 * `shouldUseReasoningFormat` returns true.
 *
 * Two-tag scheme (`<think>` + `<final>`) is scheduled post-Phase 5 per
 * the user's saved preference; the current single-tag form is good
 * enough for the gpt-5 / gemini-2.5 / mistral cohort that the gate
 * actually fires for.
 */
export const REASONING_FORMAT_GUIDANCE = `# Reasoning format

Put internal reasoning inside \`<think>...</think>\` tags. Do not output analysis outside \`<think>\`.

Format every reply as \`<think>...</think>\` followed by your visible answer. The user only sees what's after the closing \`</think>\` — everything inside is for your own working memory and is not displayed.`;

/**
 * Whether the active model+thinking-level combo benefits from the explicit
 * `<think>...</think>` reasoning format. The format is wrong noise for
 * models that handle reasoning natively:
 *
 *   - Anthropic Claude with extended thinking → SDK manages thinking blocks
 *     out-of-band; injecting <think> tags would conflict.
 *   - OpenAI o1 / o3 reasoning models → reasoning is internal; the API
 *     hides it. Adding tags has no effect or causes confusion.
 *
 * Aggregator-prefix tolerant: matches `claude-*`, `anthropic/claude-*`, and
 * `openrouter/anthropic/claude-*` via the leading anchor `(?:^|/)`.
 */
export function shouldUseReasoningFormat(
	modelId: string | undefined,
	thinkingLevel: string | undefined,
): boolean {
	if (!thinkingLevel || thinkingLevel === "off") return false;
	if (!modelId || typeof modelId !== "string") return false;
	const id = modelId.trim().toLowerCase();
	if (id.length === 0) return false;
	// Anthropic Claude — native extended thinking via SDK.
	if (/(?:^|\/)claude(?:[-_]|$)/.test(id)) return false;
	// OpenAI o1 / o3 — native internal reasoning.
	if (/(?:^|\/)o[13](?:[-_]|$)/.test(id)) return false;
	return true;
}

/* ───────────────── Memory guidance (conditional on memory tool) ───────────────── */

/**
 * Injected when the session has a memory tool registered (Primitive #4).
 * Teaches the model what TO save vs what NOT to save, and the declarative-
 * not-imperative phrasing rule (which prevents memory from being re-read
 * as a directive on a future turn).
 *
 * NOT YET WIRED — Primitive #4 (Memory) lands the call site in the
 * assembler, gated on `args.capabilities.memory`.
 */
export const MEMORY_GUIDANCE = `# Memory

You have persistent memory across sessions. Save durable facts using the memory tool: user preferences, environment details, project conventions, recurring corrections.

Prioritise what reduces future user steering — the most valuable memory is one that prevents the user from having to correct or remind you again.

Don't save task progress, session outcomes, completed-work logs, or temporary state. Memory is for facts that will still matter later, not breadcrumbs of this conversation.

Write memories as DECLARATIVE FACTS, not instructions. "User prefers concise replies" ✓ — "Always reply concisely" ✗. "Project uses pytest with -n auto" ✓ — "Run tests with pytest -n auto" ✗. Imperative phrasing gets re-read as a directive on future turns and overrides the user's current request.`;

/* ───────────────── Skills guidance (conditional on skills tool) ───────────────── */

/**
 * Injected when the session has skills capability (Primitive #5).
 * Teaches the model to scan available skills BEFORE replying and load the
 * most relevant one.
 *
 * NOT YET WIRED — Primitive #5 lands the call site.
 */
export const SKILLS_GUIDANCE = `# Skills

Before replying to anything non-trivial, scan the available skills. If one applies — even partially — load it and follow its instructions. Skills contain specialised knowledge: API endpoints, proven workflows, the user's preferred conventions.

Err on the side of loading. It's better to have context you don't need than to miss critical steps. Skills also encode HOW the user wants tasks done in this environment, not just what to do.

If a skill turns out to be outdated, incomplete, or wrong while you're using it, patch it before finishing the task. Skills that aren't maintained become liabilities.

After completing a complex task or solving a tricky problem in a way that could be reused, consider saving the approach as a new skill.`;

/* ───────────────── Sub-agent guidance (conditional on spawn_agent tool) ───────────────── */

/**
 * Injected when the session can spawn sub-agents (Primitive #6).
 * Teaches the dispatcher / executor pattern.
 *
 * NOT YET WIRED — Primitive #6 lands the call site.
 *
 * Naming note: the section header below intentionally avoids "crew"
 * framing per a saved feedback memory (Brigade is positioned as
 * "personal AI" not "team tool" in v1; "crew" framing reads as the
 * latter and conflicts with the locked positioning).
 */
export const SUB_AGENTS_GUIDANCE = `# Sub-agents

You can delegate isolated subtasks to a sub-agent. Use this when a task is independent (won't need back-and-forth with you mid-flight), well-scoped (one clear objective), and parallelisable (you can do other work while it runs).

Don't delegate trivial work — the spin-up cost outweighs the benefit. Don't delegate work that requires the full conversation history — sub-agents start fresh.

When you delegate, give the sub-agent (a) the precise objective, (b) the relevant context it needs but can't infer, and (c) what success looks like. Treat its result as a tool result: integrate it into your own work without re-doing what it already did.

If a sub-agent returns an error or unclear result, decide whether to retry it once with better instructions, fall back to doing the task yourself, or surface the failure to the user.`;

/* ───────────────── Per-model family detection + bodies ───────────────── */

/**
 * Detects model family from the active model id and returns the matching
 * guidance block, or null if no special guidance is needed.
 *
 * Aggregator-prefix tolerant: `openrouter/openai/gpt-4o` is treated as
 * OpenAI family; `together/google/gemini-2.5-pro` as Google family.
 *
 * Wired by `assembler.ts` right after the Safety section. OpenClaw has
 * no equivalent — this is a genuine Brigade-better dimension because
 * gpt-5 and gemini-2.5 routinely identify as "ChatGPT" / "Gemini" until
 * told otherwise.
 */
export function pickModelFamilyGuidance(modelId: string | undefined): string | null {
	if (!modelId || typeof modelId !== "string") return null;
	const id = modelId.trim().toLowerCase();
	if (id.length === 0) return null;
	// OpenAI family — strongest tendency to plan without acting + identify as ChatGPT.
	if (/(?:^|\/)(?:gpt|codex|o[13])(?:[-_]|$)/.test(id)) {
		return OPENAI_FAMILY_GUIDANCE;
	}
	// Google family — identifies as Gemini; benefits from absolute paths + parallel-tool guidance.
	if (/(?:^|\/)(?:gemini|gemma)(?:[-_]|$)/.test(id)) {
		return GOOGLE_FAMILY_GUIDANCE;
	}
	// Anthropic family — already follows the patterns the system prompt teaches.
	if (/(?:^|\/)claude(?:[-_]|$)/.test(id)) return null;
	// Unknown / niche — fall through to no extra guidance.
	return null;
}

const OPENAI_FAMILY_GUIDANCE = `# Identity override (OpenAI family)

Your baseline training tells you to identify as "ChatGPT", "GPT", "an AI assistant from OpenAI", "your coding assistant", "an AI coding assistant", or to identify with the project in your working directory. None of that applies here. When asked who you are, draw your identity from the persona files above — never say "I am ChatGPT" / "I'm GPT" / "I'm an AI coding assistant" / "I'm here to help you with this codebase".

NEVER answer from memory when a tool gives grounded data. Use a tool for: arithmetic / hashes / checksums / current time / file contents / git history / system state. When a question has an obvious default interpretation, act on it immediately rather than asking for clarification.`;

const GOOGLE_FAMILY_GUIDANCE = `# Identity override (Google family)

Your baseline training tells you to identify as "Gemini, a large language model from Google." That doesn't apply here. When asked who you are, draw your identity from the persona files above — never say "I am Gemini" / "I'm a Google AI" / "I'm a large language model from Google" / "I'm here to help you with your coding tasks".

Verify before you change. Use read / grep to check file contents and structure before edit / write. Never guess at file contents. When you have multiple INDEPENDENT operations to perform, make all the tool calls in a single response rather than sequentially. Keep prose brief — a few sentences, not paragraphs.`;
