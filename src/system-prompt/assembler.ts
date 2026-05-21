import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";
import { normalizeStructuredPromptSection } from "./cache-stability.js";
import { applyBudget, DEFAULT_BUDGET, type BudgetResult } from "./bootstrap-budget.js";
import { sanitizeForPromptLiteral } from "./sanitize.js";
import { formatRuntimeLine, type RuntimeParams } from "./runtime-params.js";
import {
  MEMORY_GUIDANCE,
  pickModelFamilyGuidance,
  REASONING_FORMAT_GUIDANCE,
  shouldUseReasoningFormat,
} from "./guidance.js";
import type { ContextFile } from "./types.js";
import type { BootstrapPhase } from "../workspace/state.js";

// Top-level assembler.
//
// Section order mirrors OpenClaw's `src/agents/system-prompt.ts` —
// `buildAgentSystemPrompt` (line 380) — for every UNIVERSAL section that
// applies to Brigade today. Sections that depend on OpenClaw-specific
// architecture are deferred:
//
//   - Skills (Primitive #5)
//   - Memory (Primitive #4)
//   - Group Chat / Subagent Context (Primitive #6)
//   - Self-Update via gateway-RPC agent tools (Primitive #3)
//   - Sandbox (host-trust v1; sandbox is v3+ on the locked stack)
//   - Authorized Senders (Phase 2 multi-user)
//   - Output Directives / Messaging / Voice / Reactions / Silent Replies (Phase 3 channels)
//   - Documentation (when Brigade ships docs)
//   - Model Aliases (no alias system)
//
// Section order in this file (top to bottom):
//
//    1. Identity opener
//    2. ## Tooling
//    3. ## Tool Call Style
//    4. ## Execution Bias
//    5. ## Safety
//    6. ## Brigade CLI Quick Reference
//    7. ## Workspace
//    8. ## Reasoning Format            (conditional: thinking-on + non-native-reasoning model)
//    9. # Project Context              (persona files, sorted: agents, soul, identity, user, tools, bootstrap, memory)
//   10. <!-- CACHE BOUNDARY -->
//   11. # Dynamic Project Context      (HEARTBEAT.md)
//   12. # Per-turn Notes                (ephemeral suffix, when supplied)
//   13. ## Runtime                      (host / shell / model / channel / time)

export interface AssembleArgs {
  // Resolved per-turn runtime context (host, tz, model, channel, …).
  runtime: RuntimeParams;
  // Persona files loaded from <agentDir>/workspace/, in canonical order.
  personaFiles: ContextFile[];
  // HEARTBEAT.md content if present — goes below the cache boundary.
  heartbeatFile?: ContextFile;
  // Tool descriptions, ready to inject. Empty array → "no tools" line.
  toolDescriptions: ToolDescription[];
  // Optional per-turn additions (sub-agent task framing, ephemeral notes).
  // Lives below the cache boundary so it doesn't bust the prefix.
  ephemeralSuffix?: string;
  // Lifecycle phase from the workspace state file. Matches OpenClaw: the
  // assembler does NOT emit synthetic guidance based on this. First-turn
  // behaviour comes from BOOTSTRAP.md content alone, exactly like OpenClaw
  // (`system-prompt.ts:380-927` has no per-turn branching).
  bootstrapPhase?: BootstrapPhase;
  // Active model id. Drives `shouldUseReasoningFormat` gating for the
  // `## Reasoning Format` block. Aggregator-prefix tolerant
  // (`openrouter/openai/gpt-4o` works).
  modelId?: string;
  // Active thinking level. "off" / undefined → no reasoning format block.
  // Native-reasoning models (Claude w/ extended thinking, o1/o3) skip
  // the block regardless of level.
  thinkingLevel?: string;
  // Capability gates for conditional guidance. `memory` is WIRED
  // (Primitive #4) — when true the assembler emits the `## Memory`
  // section. `skills` (#5) and `subAgents` (#6) are accepted but still
  // produce no section until their primitives ship. Gates stay false by
  // default so the cached prefix stays small.
  capabilities?: {
    memory?: boolean;
    skills?: boolean;
    subAgents?: boolean;
  };
}

export interface ToolDescription {
  name: string;
  summary: string;
}

export interface AssembledPrompt {
  text: string;
  budget: BudgetResult;
}

// Canonical persona file order — matches OpenClaw's sort. Files NOT in
// this list keep their original caller order at the end.
const PERSONA_CANONICAL_ORDER = [
  "agents.md",
  "soul.md",
  "identity.md",
  "user.md",
  "tools.md",
  "bootstrap.md",
  "memory.md",
];

function sortPersonaFiles(files: ContextFile[]): ContextFile[] {
  const rank = new Map(PERSONA_CANONICAL_ORDER.map((n, i) => [n, i]));
  return [...files].sort((a, b) => {
    const ra = rank.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

export function assembleSystemPrompt(args: AssembleArgs): AssembledPrompt {
  const lines: string[] = [];

  // 1. Identity opener.
  // Exact lift-and-shift of OpenClaw's identity line at
  // `system-prompt.ts:632` ("You are a personal assistant running inside
  // OpenClaw.") with the only Brigade-native substitution being the brand
  // name. Eight words. One brand mention. No marketing nouns. The earlier
  // verbose form ("You are the user's Brigade assistant — a personal AI
  // inside their Brigade crew. Defer to the workspace persona files…")
  // taught the model to parrot "your Brigade assistant" / "personal AI
  // running inside your Brigade workspace" in conversational replies —
  // exactly the corporate-coded tone we want to avoid. Persona refinement
  // (voice, values, identity, behavioural rules) lives in IDENTITY.md /
  // SOUL.md / AGENTS.md inside `# Project Context` below — those don't
  // need to be advertised here.
  lines.push("You are a personal assistant running inside Brigade.");
  lines.push("");

  // No first-turn synthetic guidance. Mirrors OpenClaw's choice to drive
  // first-turn behaviour from BOOTSTRAP.md content alone. The earlier
  // `**First turn: ... verbatim**` nudge regressed both gpt-5.4 (over-literal
  // bullet dumps) and Claude (auto-write USER.md without asking).
  // `bootstrapPhase` is still threaded through for future per-model-family
  // hints if a smaller model needs one.
  void args.bootstrapPhase;

  // 2. ## Tooling.
  // OpenClaw `system-prompt.ts:634-668` lift. Tool list + universal
  // trailing rules: TOOLS.md disclaimer, anti-poll closer. The empty-list
  // path uses Brigade's terser permissive line (Pi's 14-tool hardcoded
  // fallback in OpenClaw bakes in tool names that may not match what
  // Brigade actually wires).
  lines.push("## Tooling");
  if (args.toolDescriptions.length === 0) {
    lines.push(
      "Tools are wired into this turn. When the user asks you to do something that needs filesystem, shell, or search access, USE the tools you have — do not tell the user you can't.",
    );
  } else {
    lines.push("Tool availability (you may call any of these):");
    lines.push("Tool names are case-sensitive. Call tools exactly as listed.");
    for (const t of args.toolDescriptions) {
      const summary = t.summary?.trim();
      lines.push(summary ? `- ${t.name}: ${summary}` : `- ${t.name}`);
    }
    // OpenClaw universal trailing rules (`system-prompt.ts:657, 668`).
    lines.push(
      "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    );
    lines.push(
      "Do not poll status/list tools in a loop; only check on demand.",
    );
  }
  lines.push("");

  // 3. ## Tool Call Style.
  // OpenClaw `system-prompt.ts:677-689` lift. Narration rules; what we
  // synthesise vs what we show the play-by-play of. Three universal lines
  // from OpenClaw (keep narration brief / plain language / prefer tools
  // over CLI suggestions) were missing — added back.
  lines.push("## Tool Call Style");
  lines.push(
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
  );
  lines.push(
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions, force-push, secret/config edits), or when the user explicitly asks.",
  );
  lines.push(
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
  );
  lines.push(
    "Use plain human language for narration unless in a technical context.",
  );
  lines.push(
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
  );
  lines.push(
    "Pick exact tool names from the list above; tool names are case-sensitive and aliases are not accepted.",
  );
  lines.push("");

  // 4. ## Execution Bias.
  // OpenClaw `system-prompt.ts:271-275`. "If the user asks you to do the
  // work, start doing it" — no preambles, no commentary-only turns.
  // Previously this block quoted forbidden example phrases ("I'll now
  // read the file…", "Let me check the docs…") — quoting the bad pattern
  // gave the model permission to emit it, which is the opposite of what
  // we want. Phrased as a rule now, not a quote-list.
  lines.push("## Execution Bias");
  lines.push(
    "If the user asks you to do the work, start doing it in the same turn.",
  );
  lines.push(
    "Use a real tool call or concrete action first when the task is actionable; do not stop at a plan or promise-to-act reply.",
  );
  lines.push(
    "Commentary-only turns are incomplete when tools are available and the next action is clear.",
  );
  lines.push(
    "If the work will take multiple steps or a while to finish, send one short progress update before or while acting.",
  );
  lines.push(
    "Match response length to the question. Trivial questions get one-line answers; exploratory questions get a few sentences with a recommendation.",
  );
  // Anti-checklist-parroting directive. Brigade-native — no OpenClaw
  // analog. The persona files in `# Project Context` below (especially
  // BOOTSTRAP.md) sometimes contain numbered or bulleted lists of things
  // for the agent to discuss with the operator. Without this directive
  // some models (gpt-5.x is the worst offender) enumerate those lists
  // verbatim in their replies, producing a stiff "let me ask my four
  // questions in order" tone instead of natural conversation. The cure
  // is to tell the model the lists are a GUIDE, not a SCRIPT.
  lines.push(
    "When a persona file (e.g. BOOTSTRAP.md) contains a numbered or bulleted list of topics to cover with the user, treat the list as a guide for what matters — paraphrase to one or two natural questions, don't enumerate every item verbatim in your reply.",
  );
  lines.push("");

  // 5. ## Safety.
  // Exact lift-and-shift of OpenClaw's safety section
  // `system-prompt.ts:602-608`. Constitution-style anti-self-preservation
  // rules. The previous Brigade-shape three bullets (credentials,
  // destructive ops, untrusted content) were operator-protection rules
  // that overlap with the exec-gate already enforced at the tool layer;
  // OpenClaw's lines are AI-alignment rules that the gate can't enforce
  // and that ALL frontier model providers reference in their published
  // policies. Operator-protection rules can land in TOOLS.md / USER.md
  // when needed — they're persona-scope, not always-on prompt scope.
  lines.push("## Safety");
  lines.push(
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
  );
  lines.push(
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
  );
  lines.push(
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
  );
  lines.push("");

  // 5b. Per-model-family identity override (Brigade-better; not in OpenClaw).
  // Gemini and GPT routinely identify themselves as "Gemini" / "ChatGPT"
  // until told otherwise — the family blocks at `guidance.ts:207-241`
  // explicitly override that baseline identity. We pick based on the
  // model id (raw, no provider prefix — `pickModelFamilyGuidance` handles
  // the prefix stripping). Conditional: returns null for Claude (native
  // identity is "Claude", already aligned with Anthropic) and for
  // unknown / niche models.
  const familyBlock = pickModelFamilyGuidance(args.modelId);
  if (familyBlock) {
    lines.push(familyBlock);
    lines.push("");
  }

  // 6. ## Brigade CLI Quick Reference.
  // OpenClaw `system-prompt.ts:704-712` shape — gateway-lifecycle only,
  // plus a fallback line pointing at `brigade help`. The earlier version
  // enumerated eight subcommands, which trained the model to suggest
  // `brigade <foo>` in conversational replies about unrelated topics.
  // Operator-critical commands stay (gateway, onboard, doctor); the
  // rest is reachable via help-text the model can ask the user to run.
  lines.push("## Brigade CLI Quick Reference");
  lines.push("Brigade is controlled via subcommands. Do not invent commands.");
  lines.push("To manage the Gateway daemon (start/stop/restart):");
  lines.push("- `brigade gateway` — start the gateway in the foreground");
  lines.push("- `brigade gateway status` — probe a running gateway");
  lines.push("- `brigade gateway stop` — stop the running gateway");
  lines.push("- `brigade onboard` — interactive provider/model setup");
  lines.push("- `brigade doctor` — health checks");
  lines.push("If unsure, ask the user to run `brigade --help` (or `brigade gateway --help`) and paste the output.");
  lines.push("");

  // 7. ## Workspace.
  // OpenClaw `system-prompt.ts:742-744`. Brigade-native mirror, deliberately
  // terse: a long section here teaches the model to PARROT the word
  // "workspace" back at the operator in conversational replies ("running
  // inside your Brigade workspace…", "beyond the workspace setup…").
  // Pi's session cwd already defaults to this dir so the model doesn't
  // need explicit absolute-path coaching here; the per-family guidance
  // block (guidance.ts:GOOGLE_FAMILY_GUIDANCE) handles model-specific
  // absolute-path nudges where they're actually needed. The persona
  // files themselves are injected as Project Context — listing them
  // here too is redundant noise.
  lines.push("## Workspace");
  lines.push(`Your working directory is: ${args.runtime.workspaceDir}`);
  lines.push(
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
  );
  lines.push("");

  // 7b. ## Memory (conditional on the memory capability).
  // Primitive #4. Emitted only when the session has the memory tools
  // (recall_memory / read_memory) wired — gated on `capabilities.memory`.
  // Mirrors OpenClaw's `memory-core` "## Memory Recall" prompt section
  // (`extensions/memory-core/src/prompt-section.ts`): the model is told
  // to search memory BEFORE answering and how durable facts are stored.
  // MEMORY.md itself is injected separately as a persona file in
  // `# Project Context` below — this section is the behavioural wrapper.
  if (args.capabilities?.memory) {
    lines.push(MEMORY_GUIDANCE);
    lines.push("");
  }

  // 8. ## Reasoning Format.
  // OpenClaw `system-prompt.ts:858-860, 558-569`. ONLY emitted when
  // `thinkingLevel` is on AND the model isn't a native-reasoning family
  // (Claude w/ extended thinking, o1/o3 — those manage reasoning natively
  // and adding tag rules would conflict).
  if (shouldUseReasoningFormat(args.modelId, args.thinkingLevel)) {
    lines.push(REASONING_FORMAT_GUIDANCE);
    lines.push("");
  }

  // 9. # Project Context — STABLE persona files (above the cache boundary).
  // OpenClaw `system-prompt.ts:108-114` + `:869-875`. Preamble lifted
  // verbatim from OpenClaw — the previous Brigade version ("...canonical
  // description of the agent's identity, values, and ways of working.")
  // taught the model to echo those four nouns in replies. The OpenClaw
  // preamble is bland on purpose. The SOUL.md tone-nudge fires only when
  // soul.md is in the persona set; smaller models tend to skim past
  // SOUL.md without it. Sort canonically so cache-hits stay stable
  // across turns even if the loader's order varies.
  if (args.personaFiles.length > 0) {
    lines.push("# Project Context");
    lines.push("The following project context files have been loaded:");
    const hasSoulFile = args.personaFiles.some(
      (f) => f.name.toLowerCase() === "soul.md",
    );
    if (hasSoulFile) {
      lines.push(
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
      );
    }
    lines.push("");

    const sorted = sortPersonaFiles(args.personaFiles);
    const budget = applyBudget(sorted, DEFAULT_BUDGET);
    for (const file of budget.files) {
      // Strip the trailing `.md` so headings read `## AGENTS` rather than
      // the typo-looking `## AGENTS.MD`. The source path comment retains
      // the full filename for traceability.
      const heading = file.name.replace(/\.md$/i, "").toUpperCase();
      lines.push(`## ${heading}`);
      lines.push(`<!-- source: ${file.path} -->`);
      lines.push(normalizeStructuredPromptSection(file.content));
      lines.push("");
    }

    // 10. CACHE BOUNDARY.
    // OpenClaw `system-prompt-cache-boundary.ts`. Everything above here is
    // stable and gets prompt-cache-hit on Anthropic. Below, every-turn
    // dynamic stuff (heartbeat, ephemeral notes, runtime line).
    lines.push(CACHE_BOUNDARY_MARKER_LINE);
    lines.push("");

    // 11. # Dynamic Project Context — HEARTBEAT.md (below boundary).
    // OpenClaw `system-prompt.ts:900-906`. HEARTBEAT.md changes per cycle
    // so it's deliberately below the cache marker.
    if (args.heartbeatFile) {
      lines.push("# Dynamic Project Context");
      lines.push("");
      lines.push("## HEARTBEAT");
      lines.push(`<!-- source: ${args.heartbeatFile.path} -->`);
      lines.push(normalizeStructuredPromptSection(args.heartbeatFile.content));
      lines.push("");
    }

    // 12. # Per-turn Notes — sub-agent task framing or ephemeral context.
    // Brigade-specific addition (no direct OpenClaw equivalent at v1
    // single-user — OpenClaw's group/subagent context section serves the
    // same niche). Stays below the cache marker.
    if (args.ephemeralSuffix && args.ephemeralSuffix.trim()) {
      lines.push("# Per-turn Notes");
      lines.push(sanitizeForPromptLiteral(args.ephemeralSuffix));
      lines.push("");
    }

    // 13. ## Runtime.
    // OpenClaw `system-prompt.ts:920-924, 929-971`. Trailing `Reasoning:`
    // line lifts OpenClaw `:923` so the model knows whether its <think>
    // output will be visible to the operator. Brigade-native:
    // `/thinking` slash + `/status` mention OpenClaw's surface; we omit
    // those because Brigade exposes the level on the TUI header instead.
    lines.push("## Runtime");
    lines.push(formatRuntimeLine(args.runtime));
    lines.push(
      `Reasoning: ${args.thinkingLevel} (hidden unless on/stream).`,
    );

    return {
      text: lines.join("\n"),
      budget,
    };
  }

  // Fallback: no persona files. Still emit the cache boundary + runtime
  // so prompt caching works on the (very small) stable prefix.
  lines.push(CACHE_BOUNDARY_MARKER_LINE);
  lines.push("");
  if (args.heartbeatFile) {
    lines.push("# Dynamic Project Context");
    lines.push("");
    lines.push("## HEARTBEAT");
    lines.push(normalizeStructuredPromptSection(args.heartbeatFile.content));
    lines.push("");
  }
  if (args.ephemeralSuffix && args.ephemeralSuffix.trim()) {
    lines.push("# Per-turn Notes");
    lines.push(sanitizeForPromptLiteral(args.ephemeralSuffix));
    lines.push("");
  }
  lines.push("## Runtime");
  lines.push(formatRuntimeLine(args.runtime));

  return {
    text: lines.join("\n"),
    budget: { files: [], diagnostics: [], totalChars: 0 },
  };
}
