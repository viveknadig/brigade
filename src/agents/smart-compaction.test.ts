import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
  evaluateCompactionDecision,
  formatTruncationSuffix,
  resolveToolResultMaxChars,
  truncateToolResultText,
} from "./smart-compaction.js";

test("resolveToolResultMaxChars: large context window → hits hard cap", () => {
  // 200k tokens × 4 chars × 0.30 = 240_000 → clamped by hard cap 16_000.
  const limit = resolveToolResultMaxChars({ contextWindowTokens: 200_000 });
  assert.equal(limit, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
});

test("resolveToolResultMaxChars: tiny 4k window → share-cap floor (MIN_KEEP_CHARS)", () => {
  const limit = resolveToolResultMaxChars({ contextWindowTokens: 4_096 });
  // 4096 × 4 × 0.30 = ~4915 → above MIN_KEEP_CHARS, below hard cap.
  assert.ok(limit >= MIN_KEEP_CHARS);
  assert.ok(limit <= DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
  assert.equal(limit, 4915);
});

test("resolveToolResultMaxChars: enforces MIN_KEEP_CHARS floor", () => {
  // Even at a 100-token context window we never go below 2k.
  const limit = resolveToolResultMaxChars({ contextWindowTokens: 100 });
  assert.equal(limit, MIN_KEEP_CHARS);
});

test("truncateToolResultText: under cap → unchanged", () => {
  const out = truncateToolResultText({ text: "hello", maxChars: 16_000 });
  assert.equal(out.truncated, false);
  assert.equal(out.text, "hello");
  assert.equal(out.droppedChars, 0);
});

test("truncateToolResultText: empty string → unchanged", () => {
  const out = truncateToolResultText({ text: "", maxChars: 16_000 });
  assert.equal(out.truncated, false);
});

test("truncateToolResultText: head-only when no important tail", () => {
  const text = "X".repeat(10_000);
  const out = truncateToolResultText({ text, maxChars: 5_000 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 5_000);
  assert.match(out.text, /more characters truncated/);
});

test("truncateToolResultText: head+tail when error/summary keyword in tail", () => {
  const middle = "X".repeat(20_000);
  const text = `start of output\n${middle}\nERROR: something failed at the end`;
  const out = truncateToolResultText({ text, maxChars: 5_000 });
  assert.equal(out.truncated, true);
  assert.match(out.text, /middle content omitted/);
  assert.match(out.text, /something failed at the end/);
});

test("truncateToolResultText: handles non-ASCII content without crash", () => {
  const text = "天" + "気".repeat(20_000);
  const out = truncateToolResultText({ text, maxChars: 4_000 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length > 0);
});

test("formatTruncationSuffix: floors to 1 char minimum, integer", () => {
  assert.match(formatTruncationSuffix(0), /1 more characters truncated/);
  assert.match(formatTruncationSuffix(1234.7), /1234 more characters truncated/);
});

test("evaluateCompactionDecision: under threshold → no compaction recommended", () => {
  const d = evaluateCompactionDecision({
    contextWindowTokens: 200_000,
    estimatedUsageTokens: 50_000,
  });
  assert.equal(d.shouldRecommendCompaction, false);
  assert.equal(d.reason, "below-threshold");
});

test("evaluateCompactionDecision: above threshold with healthy headroom → ready", () => {
  const d = evaluateCompactionDecision({
    contextWindowTokens: 200_000,
    estimatedUsageTokens: 175_000, // > 85% trigger but plenty of room
  });
  assert.equal(d.shouldRecommendCompaction, true);
});

test("evaluateCompactionDecision: too tight headroom → don't try", () => {
  const d = evaluateCompactionDecision({
    contextWindowTokens: 200_000,
    estimatedUsageTokens: 199_000, // 1k tokens free, below 8k floor
  });
  assert.equal(d.shouldRecommendCompaction, false);
  assert.equal(d.reason, "headroom-too-tight");
});
