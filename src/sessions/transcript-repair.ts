// Transcript-level repair for orphaned tool_use blocks.
//
// `session-file-repair.ts` drops malformed JSONL lines, but a tool_use block
// can be VALID JSON and still be "orphaned" — the assistant said "I'll call
// the bash tool" and Pi wrote the tool_use block to disk, then the process
// died before the tool_result was appended. On the next run Pi will refuse
// the transcript because Anthropic's API rejects messages where a tool_use
// has no matching tool_result.
//
// The fix: scan the message history, and for every `tool_use` (in an
// assistant message) that has no matching `tool_result`, synthesise a
// placeholder tool_result with `is_error: true`. The model sees "your prior
// tool call did not return; treat it as a transient failure and retry if
// needed" instead of a hard parse error.
//
// We never DROP the tool_use — that would lose the model's plan and confuse
// it about what it has already attempted. We only ADD the missing
// tool_result so the message structure is valid again.
//
// The pairing rules:
//   • An assistant message can contain multiple tool_use blocks (parallel
//     tool calls). Each needs its own tool_result.
//   • A tool_result message contains one or more tool_result blocks, each
//     keyed by `tool_use_id`. Order doesn't matter.
//   • A tool_result block can ONLY follow the assistant turn that emitted
//     the matching tool_use. If we find a tool_result before its tool_use
//     (corruption), we drop it.

import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("sessions/transcript-repair");

const SYNTHETIC_TOOL_RESULT_TEXT =
  "[brigade] tool result was not persisted (process likely terminated " +
  "before the tool finished). Treat this as a transient failure and " +
  "retry the call if it's still relevant; otherwise proceed.";

// Loose typing — these messages are read off Pi's message array and are
// shaped by Pi's `convertToLlm`. We treat them as opaque maps with `role`
// and a content array of typed blocks.
export interface RepairableMessage {
  role: string;
  content?: unknown;
  // Future-proofing: some Pi versions include id / timestamp / etc.
  [key: string]: unknown;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name?: string;
  input?: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TranscriptRepairReport {
  mutated: boolean;
  syntheticToolResultsAdded: number;
  orphanedToolResultsDropped: number;
  unmatchedToolUseIds: string[];
}

export function sanitizeToolUseResultPairing<M extends RepairableMessage>(
  messages: M[],
): { messages: M[]; report: TranscriptRepairReport } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, report: emptyReport() };
  }

  // Pass 1: Walk forward, tracking which tool_use_ids have appeared and
  // which have been resolved. At the end of the pass, any unresolved
  // tool_use_ids need a synthetic tool_result; any tool_result whose
  // tool_use_id never appeared as a tool_use can be dropped.
  const announcedToolUseIds = new Set<string>();
  const resolvedToolUseIds = new Set<string>();
  const orphanedToolResultIds = new Set<string>();

  for (const m of messages) {
    if (!m) continue;
    const blocks = arrayContent(m.content);
    if (!blocks) continue;
    if (m.role === "assistant") {
      for (const block of blocks) {
        const tu = asToolUse(block);
        if (tu) announcedToolUseIds.add(tu.id);
      }
    } else if (m.role === "user" || m.role === "tool" || m.role === "toolResult") {
      for (const block of blocks) {
        const tr = asToolResult(block);
        if (!tr) continue;
        if (announcedToolUseIds.has(tr.tool_use_id)) {
          resolvedToolUseIds.add(tr.tool_use_id);
        } else {
          orphanedToolResultIds.add(tr.tool_use_id);
        }
      }
    }
  }

  const unmatched = [...announcedToolUseIds].filter((id) => !resolvedToolUseIds.has(id));

  if (unmatched.length === 0 && orphanedToolResultIds.size === 0) {
    return { messages, report: emptyReport() };
  }

  // Pass 2: Build the repaired transcript. We strip orphan tool_result
  // blocks, leaving the rest of their host messages intact (a user
  // message might have BOTH a stray tool_result and a real text block).
  const out: M[] = [];
  let orphanedToolResultsDropped = 0;
  for (const m of messages) {
    if (!m) {
      out.push(m);
      continue;
    }
    const blocks = arrayContent(m.content);
    if (!blocks) {
      out.push(m);
      continue;
    }
    if (m.role === "user" || m.role === "tool" || m.role === "toolResult") {
      const filtered: unknown[] = [];
      for (const block of blocks) {
        const tr = asToolResult(block);
        if (tr && orphanedToolResultIds.has(tr.tool_use_id)) {
          orphanedToolResultsDropped++;
          continue;
        }
        filtered.push(block);
      }
      if (filtered.length === blocks.length) {
        out.push(m);
      } else if (filtered.length === 0) {
        // Whole message was orphan tool_results — drop the message rather
        // than emit an empty content array (Anthropic rejects empty
        // content). This is rare but worth handling.
      } else {
        out.push({ ...(m as object), content: filtered } as M);
      }
    } else {
      out.push(m);
    }
  }

  // Pass 3: For each unresolved tool_use, append a synthetic tool_result
  // immediately AFTER the assistant message that contained it. This keeps
  // the order intact so the model sees `assistant(tool_use) →
  // user(tool_result)` exactly as it would in a normal turn.
  if (unmatched.length > 0) {
    const finalOut: M[] = [];
    const remainingUnmatched = new Set(unmatched);
    for (const m of out) {
      finalOut.push(m);
      if (!m || m.role !== "assistant") continue;
      const blocks = arrayContent(m.content);
      if (!blocks) continue;

      const synthBlocks: ToolResultBlock[] = [];
      for (const block of blocks) {
        const tu = asToolUse(block);
        if (!tu) continue;
        if (!remainingUnmatched.has(tu.id)) continue;
        remainingUnmatched.delete(tu.id);
        synthBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
          is_error: true,
        });
      }
      if (synthBlocks.length > 0) {
        finalOut.push({
          role: "user",
          content: synthBlocks,
        } as unknown as M);
      }
    }

    log.warn("transcript repaired: synthesised missing tool_result blocks", {
      syntheticCount: unmatched.length,
      orphanedDroppedCount: orphanedToolResultsDropped,
      unmatchedToolUseIds: unmatched,
    });

    return {
      messages: finalOut,
      report: {
        mutated: true,
        syntheticToolResultsAdded: unmatched.length,
        orphanedToolResultsDropped,
        unmatchedToolUseIds: unmatched,
      },
    };
  }

  if (orphanedToolResultsDropped > 0) {
    log.warn("transcript repaired: dropped orphan tool_result blocks", {
      orphanedDroppedCount: orphanedToolResultsDropped,
    });
  }

  return {
    messages: out,
    report: {
      mutated: orphanedToolResultsDropped > 0,
      syntheticToolResultsAdded: 0,
      orphanedToolResultsDropped,
      unmatchedToolUseIds: [],
    },
  };
}

function arrayContent(content: unknown): unknown[] | null {
  return Array.isArray(content) ? content : null;
}

function asToolUse(block: unknown): ToolUseBlock | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; id?: unknown };
  // Anthropic spec uses "tool_use"; some Pi shapes use "toolUse" — accept both.
  if ((b.type !== "tool_use" && b.type !== "toolUse") || typeof b.id !== "string") {
    return null;
  }
  return block as ToolUseBlock;
}

function asToolResult(block: unknown): ToolResultBlock | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; tool_use_id?: unknown; toolUseId?: unknown };
  if (b.type !== "tool_result" && b.type !== "toolResult") return null;
  const id = typeof b.tool_use_id === "string" ? b.tool_use_id : typeof b.toolUseId === "string" ? b.toolUseId : null;
  if (!id) return null;
  return { type: "tool_result", tool_use_id: id, ...(block as object) } as ToolResultBlock;
}

function emptyReport(): TranscriptRepairReport {
  return {
    mutated: false,
    syntheticToolResultsAdded: 0,
    orphanedToolResultsDropped: 0,
    unmatchedToolUseIds: [],
  };
}
