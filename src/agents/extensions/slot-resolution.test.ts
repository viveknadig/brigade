// Tests for the Lane J slot-resolution shim across the three new slots:
//   - compaction provider (delegated via compactWithSlotResolution)
//   - context-engine + agent-harness (resolution shape only — the agent
//     loop uses the registry resolver directly, and these tests confirm
//     the registry behaviour both surfaces depend on)
//
// Shape-only today: when no slot is pinned, Brigade's built-in path runs;
// when a slot is pinned and a matching plugin is registered, the resolver
// returns that plugin. compactWithSlotResolution wraps the call so the
// caller gets either the summarised string or `{fallback: true}`.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { compactWithSlotResolution } from "../smart-compaction.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import type {
  AgentHarness,
  CompactionProvider,
  ContextEngineCapability,
} from "./types.js";

const META = {
  agentId: "main",
  workspaceDir: "/ws",
  cwd: "/cwd",
  config: {} as BrigadeConfig,
};

/** Build a config with `extensions.slots.<slot> = <id>` pinned. */
function configWithSlot(slot: string, id: string): BrigadeConfig {
  return { extensions: { slots: { [slot]: id } } } as unknown as BrigadeConfig;
}

/** Minimal valid CompactionProvider that records calls + returns a tagged summary. */
function fakeCompactor(id: string, summary = `summary-from-${id}`): CompactionProvider & {
  calls: Array<{ messages: ReadonlyArray<unknown>; ratio: number }>;
} {
  const calls: Array<{ messages: ReadonlyArray<unknown>; ratio: number }> = [];
  return {
    id,
    label: id,
    async summarize(args) {
      calls.push({ messages: args.messages, ratio: args.compressionRatio });
      return summary;
    },
    calls,
  };
}

/** Minimal valid ContextEngineCapability. */
function fakeContextEngine(id: string): ContextEngineCapability {
  return {
    id,
    label: id,
    async assemble(args) {
      return { messages: args.sessionMessages, systemPromptAddition: `addition-${id}` };
    },
  };
}

/** Minimal valid AgentHarness. */
function fakeHarness(id: string, priority = 0): AgentHarness {
  return {
    id,
    label: id,
    priority,
    supports: () => true,
    async runAttempt() {
      return { reply: `reply-from-${id}` };
    },
  };
}

describe("BrigadeExtensionRegistry.resolveSlot — Lane J slots", () => {
  it("returns undefined for compaction when no slot is pinned", () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).compactionProvider(fakeCompactor("c1"));
    // Empty config — `extensions.slots.compaction` is unset.
    const resolved = reg.resolveSlot("compaction", {} as BrigadeConfig, reg.compactionProviders);
    assert.equal(resolved, undefined);
  });

  it("returns the registered compaction provider when the slot pins its id", () => {
    const reg = new BrigadeExtensionRegistry();
    const c1 = fakeCompactor("c1");
    const c2 = fakeCompactor("c2");
    reg.context(META).compactionProvider(c1);
    reg.context(META).compactionProvider(c2);
    const resolved = reg.resolveSlot(
      "compaction",
      configWithSlot("compaction", "c2"),
      reg.compactionProviders,
    );
    assert.ok(resolved);
    assert.equal(resolved?.id, "c2");
  });

  it("returns undefined when the pinned compaction id isn't registered", () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).compactionProvider(fakeCompactor("c1"));
    const resolved = reg.resolveSlot(
      "compaction",
      configWithSlot("compaction", "missing"),
      reg.compactionProviders,
    );
    assert.equal(resolved, undefined);
  });

  it("resolves the contextEngine slot independently of other slots", () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).contextEngine(fakeContextEngine("eng-a"));
    reg.context(META).contextEngine(fakeContextEngine("eng-b"));
    const resolved = reg.resolveSlot(
      "contextEngine",
      configWithSlot("contextEngine", "eng-b"),
      reg.contextEngines,
    );
    assert.equal(resolved?.id, "eng-b");
  });

  it("resolves the agentHarness slot when pinned + registered", () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).agentHarness(fakeHarness("codex"));
    reg.context(META).agentHarness(fakeHarness("claude-code"));
    const resolved = reg.resolveSlot(
      "agentHarness",
      configWithSlot("agentHarness", "claude-code"),
      reg.agentHarnesses,
    );
    assert.equal(resolved?.id, "claude-code");
  });
});

describe("compactWithSlotResolution", () => {
  it("returns {fallback: true} when no registry is passed", async () => {
    const out = await compactWithSlotResolution({
      messages: [{ role: "user", content: "hi" }],
      compressionRatio: 0.5,
      config: {} as BrigadeConfig,
    });
    assert.deepEqual(out, { fallback: true });
  });

  it("returns {fallback: true} when the slot isn't pinned", async () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).compactionProvider(fakeCompactor("c1"));
    const out = await compactWithSlotResolution({
      messages: [{ role: "user", content: "hi" }],
      compressionRatio: 0.5,
      registry: reg,
      config: {} as BrigadeConfig,
    });
    assert.deepEqual(out, { fallback: true });
  });

  it("returns {fallback: true} when the pinned id isn't registered", async () => {
    const reg = new BrigadeExtensionRegistry();
    reg.context(META).compactionProvider(fakeCompactor("c1"));
    const out = await compactWithSlotResolution({
      messages: [{ role: "user", content: "hi" }],
      compressionRatio: 0.5,
      registry: reg,
      config: configWithSlot("compaction", "missing"),
    });
    assert.deepEqual(out, { fallback: true });
  });

  it("delegates to the registered provider's summarize() when pinned", async () => {
    const reg = new BrigadeExtensionRegistry();
    const c1 = fakeCompactor("c1", "the-summary");
    reg.context(META).compactionProvider(c1);
    const messages = [{ role: "user", content: "hello" }];
    const out = await compactWithSlotResolution({
      messages,
      compressionRatio: 0.4,
      registry: reg,
      config: configWithSlot("compaction", "c1"),
    });
    assert.equal(out, "the-summary");
    assert.equal(c1.calls.length, 1);
    assert.equal(c1.calls[0]?.ratio, 0.4);
    assert.equal(c1.calls[0]?.messages, messages);
  });
});
