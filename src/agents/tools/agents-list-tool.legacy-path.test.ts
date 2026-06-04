/**
 * Stage-C regression guard: when `cfg.org` is ABSENT (the legacy
 * default), the `agents_list.canSend` flag uses the LEGACY policy
 * (`createAgentToAgentPolicy` over `cfg.session.agentToAgent`) — NOT
 * the derived org graph. This is the additive-proof for Stage C: the
 * existing pre-org code path runs bit-for-bit unchanged.
 *
 * Two parallel fixtures:
 *   1. Empty A2A allowlist → canSend FALSE for peers (legacy posture).
 *   2. Allowlist with `*` enabled → canSend TRUE for peers.
 *
 * Both fixtures OMIT `cfg.org` so the org adapter MUST be inert.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeAgentsListTool } from "./agents-list-tool.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeCfg(cfg: unknown): void {
  writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

interface ListedAgent {
  id: string;
  canSpawn: boolean;
  canSend: boolean;
  self?: boolean;
}

interface ListedResult {
  agents: ListedAgent[];
}

async function runTool(requesterAgentId: string): Promise<ListedResult> {
  const tool = makeAgentsListTool({ requesterAgentId });
  const res = await tool.execute("test-call-id", {});
  const block = res.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as ListedResult;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "brigade-agents-list-legacy-"));
  mkdirSync(join(stateDir, "agents"), { recursive: true });
  prevStateDir = process.env.BRIGADE_STATE_DIR;
  process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
  else process.env.BRIGADE_STATE_DIR = prevStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("agents_list canSend legacy-path regression guard (cfg.org ABSENT)", () => {
  it("(1) A2A disabled + no allow → cross-agent canSend=false (legacy)", async () => {
    // NO cfg.org. NO cfg.session.agentToAgent.enabled. Cross-agent
    // send must be FALSE — the legacy policy refuses by default.
    writeCfg({
      agents: { defaults: { provider: "openrouter" }, main: {}, peer: {} },
    });
    const out = await runTool("main");
    const peer = out.agents.find((a) => a.id === "peer");
    assert.ok(peer);
    assert.equal(peer.canSend, false, "legacy A2A disabled → canSend must be false");
  });

  it("(2) A2A enabled + wildcard allow → canSend=true (legacy)", async () => {
    // NO cfg.org. A2A explicitly enabled with `*` wildcard.
    writeCfg({
      agents: { defaults: { provider: "openrouter" }, main: {}, peer: {} },
      session: {
        agentToAgent: {
          enabled: true,
          allow: [{ from: "*", to: "*" }],
        },
      },
    });
    const out = await runTool("main");
    const peer = out.agents.find((a) => a.id === "peer");
    assert.ok(peer);
    assert.equal(peer.canSend, true, "legacy wildcard allow → canSend must be true");
  });

  it("(3) cfg.org PRESENT but mode=explicit → still legacy path", async () => {
    // mode=explicit is the operator's opt-OUT of derived A2A. The
    // legacy allowlist takes effect; deriver returns undefined.
    writeCfg({
      agents: {
        defaults: { provider: "openrouter" },
        main: { org: { department: "exec", reportsTo: null } },
        peer: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "explicit" } },
      session: { agentToAgent: { enabled: false } },
    });
    const out = await runTool("main");
    const peer = out.agents.find((a) => a.id === "peer");
    assert.ok(peer);
    // Legacy posture: A2A disabled → canSend false.
    assert.equal(peer.canSend, false);
  });
});
