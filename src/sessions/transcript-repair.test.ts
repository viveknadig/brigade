import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeToolUseResultPairing } from "./transcript-repair.js";

interface Block {
  type: string;
  id?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function msg(role: string, content: Block[]): { role: string; content: Block[] } {
  return { role, content };
}

test("sanitizeToolUseResultPairing: empty array is a no-op", () => {
  const r = sanitizeToolUseResultPairing([]);
  assert.equal(r.report.mutated, false);
  assert.equal(r.report.syntheticToolResultsAdded, 0);
});

test("sanitizeToolUseResultPairing: well-formed transcript is identity", () => {
  const messages = [
    msg("user", [{ type: "text", text: "hi" }]),
    msg("assistant", [
      { type: "text", text: "calling tool" },
      { type: "tool_use", id: "tu_1" },
    ]),
    msg("user", [
      { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ok" }] },
    ]),
    msg("assistant", [{ type: "text", text: "done" }]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.mutated, false);
  assert.strictEqual(r.messages, messages);
});

test("sanitizeToolUseResultPairing: orphan tool_use gets a synthetic tool_result appended after the assistant", () => {
  const messages = [
    msg("user", [{ type: "text", text: "go" }]),
    msg("assistant", [
      { type: "text", text: "running tool" },
      { type: "tool_use", id: "tu_1" },
    ]),
    // tool_result lost to power-loss
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.mutated, true);
  assert.equal(r.report.syntheticToolResultsAdded, 1);
  assert.deepEqual(r.report.unmatchedToolUseIds, ["tu_1"]);
  // The synthetic tool_result must come immediately after the assistant.
  assert.equal(r.messages.length, 3);
  const synth = r.messages[2] as { role: string; content: Block[] };
  assert.equal(synth.role, "user");
  assert.equal(synth.content[0]?.type, "tool_result");
  assert.equal(synth.content[0]?.tool_use_id, "tu_1");
  assert.equal(synth.content[0]?.is_error, true);
});

test("sanitizeToolUseResultPairing: multiple orphans across two assistant turns", () => {
  const messages = [
    msg("assistant", [{ type: "tool_use", id: "tu_a" }]),
    msg("assistant", [{ type: "tool_use", id: "tu_b" }]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.syntheticToolResultsAdded, 2);
  // Synthetic results must be inserted immediately after their owning
  // assistant, in order: assistant_a, synth_a, assistant_b, synth_b.
  assert.equal(r.messages.length, 4);
  const synthA = r.messages[1] as { content: Block[] };
  const synthB = r.messages[3] as { content: Block[] };
  assert.equal(synthA.content[0]?.tool_use_id, "tu_a");
  assert.equal(synthB.content[0]?.tool_use_id, "tu_b");
});

test("sanitizeToolUseResultPairing: orphan tool_result (no matching tool_use) is dropped", () => {
  const messages = [
    msg("user", [
      { type: "tool_result", tool_use_id: "tu_unknown", content: "leftover" },
      { type: "text", text: "real text" },
    ]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.mutated, true);
  assert.equal(r.report.orphanedToolResultsDropped, 1);
  // The text block survives.
  const surviving = r.messages[0] as { content: Block[] };
  assert.equal(surviving.content.length, 1);
  assert.equal(surviving.content[0]?.type, "text");
});

test("sanitizeToolUseResultPairing: paired multiple tools in one assistant turn", () => {
  const messages = [
    msg("assistant", [
      { type: "tool_use", id: "tu_1" },
      { type: "tool_use", id: "tu_2" },
    ]),
    msg("user", [
      { type: "tool_result", tool_use_id: "tu_2", content: "B" },
      { type: "tool_result", tool_use_id: "tu_1", content: "A" },
    ]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.mutated, false);
});

test("sanitizeToolUseResultPairing: handles toolUse / toolResult camelCase variants", () => {
  const messages = [
    msg("assistant", [{ type: "toolUse", id: "tu_x" }]),
    msg("user", [{ type: "toolResult", tool_use_id: "tu_x", content: "ok" }]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.mutated, false);
});

test("sanitizeToolUseResultPairing: mixed orphan use + orphan result", () => {
  const messages = [
    msg("user", [{ type: "tool_result", tool_use_id: "tu_ghost", content: "?" }]),
    msg("assistant", [{ type: "tool_use", id: "tu_real" }]),
  ];
  const r = sanitizeToolUseResultPairing(messages);
  assert.equal(r.report.syntheticToolResultsAdded, 1);
  assert.equal(r.report.orphanedToolResultsDropped, 1);
  // First message had only the orphan tool_result → dropped entirely.
  // Result should be: assistant(tu_real), synthetic(tu_real)
  assert.equal(r.messages.length, 2);
});
