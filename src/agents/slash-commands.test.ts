import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSlashCommand, SLASH_COMMAND_HELP } from "./slash-commands.js";

test("parseSlashCommand: empty string passes through", () => {
  const r = parseSlashCommand("");
  assert.equal(r.type, "passthrough");
  if (r.type === "passthrough") assert.equal(r.message, "");
});

test("parseSlashCommand: regular text passes through unchanged", () => {
  const r = parseSlashCommand("hello world");
  assert.equal(r.type, "passthrough");
  if (r.type === "passthrough") assert.equal(r.message, "hello world");
});

test("parseSlashCommand: leading whitespace before / still triggers", () => {
  const r = parseSlashCommand("   /help");
  assert.equal(r.type, "help");
});

test("parseSlashCommand: /model anthropic/claude-opus-4-7", () => {
  const r = parseSlashCommand("/model anthropic/claude-opus-4-7");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "anthropic");
    assert.equal(r.modelId, "claude-opus-4-7");
  }
});

test("parseSlashCommand: /model openrouter/openai/gpt-5.4-mini (modelId contains a slash)", () => {
  // OpenRouter routes via family-prefixed model IDs — must split on FIRST
  // slash and keep everything after it as the modelId. Earlier validator
  // forbade slashes in the modelId portion, which broke OpenRouter entirely.
  const r = parseSlashCommand("/model openrouter/openai/gpt-5.4-mini");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "openrouter");
    assert.equal(r.modelId, "openai/gpt-5.4-mini");
  }
});

test("parseSlashCommand: /model bedrock/anthropic.claude-3-5-sonnet:0 (modelId contains colon)", () => {
  // Bedrock model ARNs use colons in the version suffix.
  const r = parseSlashCommand("/model bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "bedrock");
    assert.equal(r.modelId, "anthropic.claude-3-5-sonnet-20241022-v2:0");
  }
});

test("parseSlashCommand: /model with no args returns help-style result", () => {
  const r = parseSlashCommand("/model");
  assert.equal(r.type, "help");
});

test("parseSlashCommand: /model with no slash separator errors", () => {
  const r = parseSlashCommand("/model claude-opus-4-7");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: /model with empty provider errors", () => {
  const r = parseSlashCommand("/model /claude-opus-4-7");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: /model with empty modelId errors", () => {
  const r = parseSlashCommand("/model anthropic/");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: /model with too many args errors", () => {
  const r = parseSlashCommand("/model anthropic/foo extra");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: /thinking high", () => {
  const r = parseSlashCommand("/thinking high");
  assert.equal(r.type, "thinking");
  if (r.type === "thinking") assert.equal(r.level, "high");
});

test("parseSlashCommand: /thinking unknown errors", () => {
  const r = parseSlashCommand("/thinking turbo");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: /reset", () => {
  const r = parseSlashCommand("/reset");
  assert.equal(r.type, "reset");
});

test("parseSlashCommand: /reset with extra arg errors", () => {
  const r = parseSlashCommand("/reset now");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: unknown command passes through", () => {
  // Future-proofing: don't error on unknown slash commands. The user may
  // have invented their own, the model may know what to do.
  const r = parseSlashCommand("/something-the-model-handles arg1 arg2");
  assert.equal(r.type, "passthrough");
});

test("parseSlashCommand: /MODEL is case-insensitive on the head", () => {
  const r = parseSlashCommand("/MODEL anthropic/claude-opus-4-7");
  assert.equal(r.type, "model");
});

test("parseSlashCommand: provider name with shell metacharacter rejected", () => {
  const r = parseSlashCommand("/model anth$ropic/foo");
  assert.equal(r.type, "error");
});

test("SLASH_COMMAND_HELP: all entries have non-empty fields", () => {
  for (const entry of SLASH_COMMAND_HELP) {
    assert.ok(entry.command.length > 0);
    assert.ok(entry.description.length > 0);
  }
});

// ── Edge cases identified in the Phase 3 final audit ─────────────────

test("parseSlashCommand: /thinking with no args is an error", () => {
  const r = parseSlashCommand("/thinking");
  assert.equal(r.type, "error");
  if (r.type === "error") {
    assert.match(r.message, /thinking/i);
  }
});

test("parseSlashCommand: /thinking with each valid level returns level", () => {
  for (const level of ["off", "low", "medium", "high"]) {
    const r = parseSlashCommand(`/thinking ${level}`);
    assert.equal(r.type, "thinking", `'${level}' should be accepted`);
    if (r.type === "thinking") assert.equal(r.level, level);
  }
});

test("parseSlashCommand: /thinking with unknown level is an error", () => {
  const r = parseSlashCommand("/thinking xhigh");
  assert.equal(r.type, "error");
});

test("parseSlashCommand: command head is case-insensitive", () => {
  const r = parseSlashCommand("/MODEL anthropic/claude-opus-4-7");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "anthropic");
    assert.equal(r.modelId, "claude-opus-4-7");
  }
});

test("parseSlashCommand: /reset with extra args is an error", () => {
  const r = parseSlashCommand("/reset garbage");
  assert.equal(r.type, "error");
  if (r.type === "error") assert.match(r.message, /no arguments/);
});

test("parseSlashCommand: /model with multi-segment id (openrouter/anthropic/claude-...)", () => {
  // Three-segment model id (provider via openrouter) should parse cleanly:
  // first segment is provider, REST is the modelId verbatim.
  const r = parseSlashCommand("/model openrouter/anthropic/claude-opus-4-7");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "openrouter");
    assert.equal(r.modelId, "anthropic/claude-opus-4-7");
  }
});

test("parseSlashCommand: /model with no args returns help (parser convention)", () => {
  // The current parser convention: /model alone means "tell me the active
  // model" — the help branch. Caller decides how to render. Lock this
  // behaviour so a future refactor doesn't silently change it.
  const r = parseSlashCommand("/model");
  assert.equal(r.type, "help");
});

test("parseSlashCommand: tab-separated args parse the same as space-separated", () => {
  const r = parseSlashCommand("/model\tanthropic/claude-opus-4-7");
  assert.equal(r.type, "model");
  if (r.type === "model") {
    assert.equal(r.provider, "anthropic");
    assert.equal(r.modelId, "claude-opus-4-7");
  }
});
