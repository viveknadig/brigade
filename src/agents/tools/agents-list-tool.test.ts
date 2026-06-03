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

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agents-list-"));
	mkdirSync(join(stateDir, "agents"), { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

interface ListedAgent {
	id: string;
	name?: string;
	configured: boolean;
}

interface ListedResult {
	requester: string;
	allowAny: boolean;
	agents: ListedAgent[];
}

async function runTool(requesterAgentId?: string): Promise<ListedResult> {
	const tool = makeAgentsListTool(requesterAgentId !== undefined ? { requesterAgentId } : {});
	const result = await tool.execute("test-call-id", {});
	const text = result.content?.[0];
	if (!text || text.type !== "text") throw new Error("expected text content");
	return JSON.parse(text.text) as ListedResult;
}

describe("agents_list tool — OC-mirror shape (allowlist-scoped)", () => {
	it("returns just the caller when cfg has only one configured agent", async () => {
		writeCfg({ agents: { defaults: { provider: "openrouter" }, main: {} } });
		const out = await runTool("main");
		assert.equal(out.requester, "main");
		assert.equal(out.allowAny, false);
		assert.equal(out.agents.length, 1);
		assert.equal(out.agents[0]?.id, "main");
		assert.equal(out.agents[0]?.configured, true);
	});

	it("returns ONLY the requester when subagents.allowAgents is empty (allowlist-scoped)", async () => {
		// OC contract: with [main, math] configured and no spawn allowlist,
		// agents_list returns ONLY the requester. The model can't see
		// `mathematician` because they aren't an allowed sub-agent target.
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				mathematician: { name: "Mathematician" },
			},
		});
		const out = await runTool("main");
		assert.equal(out.allowAny, false);
		assert.equal(out.agents.length, 1);
		assert.equal(out.agents[0]?.id, "main");
	});

	it("includes peers listed in subagents.allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					subagents: { allowAgents: ["netpulse"] },
				},
				main: {},
				netpulse: {},
				support: {},
			},
		});
		const out = await runTool("main");
		assert.equal(out.allowAny, false);
		const ids = out.agents.map((a) => a.id);
		// Requester first, allowed peer next; `support` is NOT in allowlist.
		assert.equal(ids[0], "main");
		assert.ok(ids.includes("netpulse"));
		assert.ok(!ids.includes("support"));
	});

	it("per-agent override of subagents.allowAgents overrides defaults", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: { subagents: { allowAgents: ["*"] } },
				netpulse: {},
				support: {},
			},
		});
		const out = await runTool("main");
		assert.equal(out.allowAny, true);
		const ids = out.agents.map((a) => a.id);
		assert.ok(ids.includes("netpulse"));
		assert.ok(ids.includes("support"));
	});

	it("requester is always FIRST in the list", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", subagents: { allowAgents: ["*"] } },
				main: {},
				alpha: {},
				zeta: {},
			},
		});
		const out = await runTool("zeta");
		assert.equal(out.agents[0]?.id, "zeta");
		assert.equal(out.allowAny, true);
	});

	it("propagates name when configured", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", subagents: { allowAgents: ["*"] } },
				main: {},
				mathematician: { name: "Mathematician" },
			},
		});
		const out = await runTool("main");
		const math = out.agents.find((a) => a.id === "mathematician");
		assert.equal(math?.name, "Mathematician");
	});

	it("tool description mirrors the reference one-liner", () => {
		const tool = makeAgentsListTool({ requesterAgentId: "main" });
		assert.match(tool.description, /List Brigade agent ids/);
		assert.match(tool.description, /sessions_spawn/);
		assert.match(tool.description, /runtime="subagent"/);
		assert.match(tool.description, /subagent allowlists/);
	});
});
