import type { BrigadeConfig } from "../config/io.js";

// Allows a brigade.json author to short-circuit the assembler entirely.
// When set, the assembled prompt is *replaced* (not appended) by the
// override string — useful for testing custom personas without editing
// workspace files, and for the `--system-prompt-file` CLI flag once that
// lands.

export interface OverrideArgs {
  config: BrigadeConfig;
  agentId: string;
}

export function resolveSystemPromptOverride(args: OverrideArgs): string | undefined {
  const agents = args.config.agents as Record<string, AgentSlice> | undefined;
  const perAgent = agents?.[args.agentId]?.systemPromptOverride;
  if (typeof perAgent === "string" && perAgent.trim()) return perAgent;
  // Top-level defaults (NOT an agent literally named "defaults") apply when
  // no agent-specific override is set.
  const fallback = args.config.defaults?.systemPromptOverride;
  if (typeof fallback === "string" && fallback.trim()) return fallback;
  return undefined;
}

interface AgentSlice {
  systemPromptOverride?: string;
}
