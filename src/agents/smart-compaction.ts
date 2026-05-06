// Smart compaction support for Brigade.
//
// Two responsibilities, both centred on keeping the context window healthy:
//
// 1. Tool-result truncation — bound any single tool's output to a safe share
//    of the model's context window. A 10 MB grep result that lands in the
//    transcript verbatim will OOM a small-context model on the next turn;
//    head+tail truncation with a clear notice keeps the transcript usable
//    while preserving the output's beginning and (if it looks important) end.
//
// 2. Compaction-window math — given the active model's context budget plus
//    the running token usage, decide whether the next turn should compact
//    before issuing the prompt. Pi 0.70.x manages compaction internally
//    when a session is configured for it; this module provides the
//    threshold + safe-floor helpers that the wrapper uses to decide
//    whether to *recommend* a compaction up front.
//
// All limits are configurable via brigade.json
// (`agents.defaults.contextLimits`); the defaults below are tuned to the
// observed sweet spot across Anthropic / OpenAI / Google / Ollama models.

// ─────────────────────────────────────────────────────────────────────────────
// Tool-result truncation constants.
//
// A tool result is bounded by the smaller of:
//   • a hard cap (`DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS`)
//   • a context-share cap (`MAX_TOOL_RESULT_CONTEXT_SHARE` × context window)
// with a floor of `MIN_KEEP_CHARS` so 8k-context models still see something
// useful from a tool that returned less than 2 KiB.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.30;
export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000;
export const MIN_KEEP_CHARS = 2_000;

// Approx. chars per token across modern tokenizers (BPE-flavoured) — close
// enough for budgeting; the exact rate doesn't matter for "should we
// truncate" decisions, only for sizing the bucket.
const APPROX_CHARS_PER_TOKEN = 4;

const HEAD_TAIL_SPLIT_TAIL_RATIO = 0.30;          // up to 30% of budget for tail
const HEAD_TAIL_TAIL_BUDGET_CAP = 4_000;          // never spend more than 4k chars on the tail
const HEAD_TAIL_OMISSION_MARKER =
  "\n\n[… middle content omitted — head and tail preserved …]\n\n";

// Matchers for "this tool result has an important tail" — error blocks,
// summary lines, JSON-end braces, etc. When matched we use the head+tail
// strategy; otherwise we keep the head only and discard the rest.
const IMPORTANT_TAIL_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /summary\s*:/i,
  /\}\s*$/, // JSON object close near the end
  /\]\s*$/, // JSON array close near the end
];

export interface ResolveToolResultLimitArgs {
  // Total context window in tokens (from the model registry). Required so the
  // share cap can scale with model size.
  contextWindowTokens: number;
  // Optional override (config-driven). When set, this is the hard cap; the
  // share-based cap still applies.
  hardCharOverride?: number;
}

export function resolveToolResultMaxChars(args: ResolveToolResultLimitArgs): number {
  const sharedCap = Math.floor(
    args.contextWindowTokens * APPROX_CHARS_PER_TOKEN * MAX_TOOL_RESULT_CONTEXT_SHARE,
  );
  const hardCap = args.hardCharOverride ?? DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  // Floor — even at 8k context (~32k chars), a 30% share is ~9.6k. We want
  // tools to surface at least 2k of useful output even on a tiny window.
  return Math.max(MIN_KEEP_CHARS, Math.min(hardCap, sharedCap));
}

export interface TruncateToolResultArgs {
  text: string;
  maxChars: number;
}

export interface TruncationOutcome {
  text: string;
  truncated: boolean;
  droppedChars: number;
}

export function truncateToolResultText(args: TruncateToolResultArgs): TruncationOutcome {
  const { text, maxChars } = args;
  if (typeof text !== "string" || text.length <= maxChars) {
    return { text, truncated: false, droppedChars: 0 };
  }

  // Reserve room for the truncation suffix so the suffix itself doesn't push
  // us back over the limit.
  const suffixSample = formatTruncationSuffix(text.length); // worst-case length
  const budget = Math.max(MIN_KEEP_CHARS, maxChars - suffixSample.length);

  if (hasImportantTail(text)) {
    const tailBudget = Math.min(
      Math.floor(budget * HEAD_TAIL_SPLIT_TAIL_RATIO),
      HEAD_TAIL_TAIL_BUDGET_CAP,
    );
    const headBudget = Math.max(0, budget - tailBudget - HEAD_TAIL_OMISSION_MARKER.length);
    const head = text.slice(0, headBudget);
    const tail = text.slice(text.length - tailBudget);
    const droppedChars = text.length - head.length - tail.length;
    const out = head + HEAD_TAIL_OMISSION_MARKER + tail + formatTruncationSuffix(droppedChars);
    return { text: out, truncated: true, droppedChars };
  }

  // No important tail signal: keep the head only.
  const head = text.slice(0, budget);
  const droppedChars = text.length - head.length;
  return {
    text: head + formatTruncationSuffix(droppedChars),
    truncated: true,
    droppedChars,
  };
}

export function formatTruncationSuffix(droppedChars: number): string {
  const n = Math.max(1, Math.floor(droppedChars));
  return `\n\n[… ${n} more characters truncated …]`;
}

function hasImportantTail(text: string): boolean {
  // Cheap test: only inspect the trailing 1 KiB. A "summary" or "error" block
  // an entire context window away from the end isn't an important *tail*.
  const sample = text.slice(Math.max(0, text.length - 1024));
  for (const p of IMPORTANT_TAIL_PATTERNS) if (p.test(sample)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction-window math. Pi triggers compaction internally when context
// usage breaches its own threshold; this helper lets the wrapper *anticipate*
// the trigger so a "we're going to compact next" log/heartbeat fires before
// the user sees a multi-second pause.
// ─────────────────────────────────────────────────────────────────────────────

// Below this prompt-budget floor we refuse to compact and warn instead — at
// 8k tokens of headroom there isn't enough room for the system prompt + a
// summarisation instruction + a useful summary, so the right move is to
// surface the overflow rather than blunder a compaction.
export const MIN_PROMPT_BUDGET_TOKENS = 8_000;
// What fraction of context must be free post-compaction to be worth doing?
// Below this the compaction "succeeds" but the next turn immediately tips
// over again.
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
// Compaction is recommended once usage crosses this share of the window.
export const COMPACTION_TRIGGER_RATIO = 0.85;

export interface CompactionDecisionArgs {
  contextWindowTokens: number;
  estimatedUsageTokens: number;
}

export interface CompactionDecision {
  shouldRecommendCompaction: boolean;
  triggerThresholdTokens: number;
  promptBudgetTokens: number;
  reason: "below-threshold" | "headroom-tight" | "headroom-too-tight" | "ready";
}

export function evaluateCompactionDecision(args: CompactionDecisionArgs): CompactionDecision {
  const triggerThresholdTokens = Math.floor(args.contextWindowTokens * COMPACTION_TRIGGER_RATIO);
  const promptBudgetTokens = Math.max(0, args.contextWindowTokens - args.estimatedUsageTokens);

  if (args.estimatedUsageTokens < triggerThresholdTokens) {
    return {
      shouldRecommendCompaction: false,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "below-threshold",
    };
  }
  if (promptBudgetTokens < MIN_PROMPT_BUDGET_TOKENS) {
    return {
      shouldRecommendCompaction: false,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "headroom-too-tight",
    };
  }
  const targetFreeTokens = Math.floor(args.contextWindowTokens * MIN_PROMPT_BUDGET_RATIO);
  if (promptBudgetTokens < targetFreeTokens) {
    return {
      shouldRecommendCompaction: true,
      triggerThresholdTokens,
      promptBudgetTokens,
      reason: "headroom-tight",
    };
  }
  return {
    shouldRecommendCompaction: true,
    triggerThresholdTokens,
    promptBudgetTokens,
    reason: "ready",
  };
}
