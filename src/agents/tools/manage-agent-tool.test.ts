/**
 * `manage_agent` tool tests.
 *
 * Primary concern: STDIO + brigade.json mutation races. The CLI helpers
 * (`runAgentsAdd` etc.) capture process.stdout/stderr by REPLACING the
 * stream's `write` method. Two concurrent calls would each save the OTHER
 * call's hook as "original" and corrupt stdout permanently when restoring.
 * The serial mutex in `manage-agent-tool.ts` removes that race; this test
 * locks in the invariant.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeManageAgentTool } from "./manage-agent-tool.js";
import { makeAgentsListTool } from "./agents-list-tool.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeCfg(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

function readCfg(): {
	agents?: {
		defaults?: { subagents?: { allowAgents?: unknown; autoAllowOnCreate?: unknown } };
		[k: string]: unknown;
	};
	[k: string]: unknown;
} {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8"));
}

function readAllowAgents(): string[] {
	const cfg = readCfg();
	const list = cfg.agents?.defaults?.subagents?.allowAgents;
	return Array.isArray(list) ? (list as string[]) : [];
}

async function runListTool(requesterAgentId: string): Promise<{
	requester: string;
	allowAny: boolean;
	agents: Array<{ id: string; name?: string; configured: boolean }>;
}> {
	const tool = makeAgentsListTool({ requesterAgentId });
	const result = await tool.execute("test-call-id", {});
	const text = result.content?.[0];
	if (!text || text.type !== "text") throw new Error("expected text content");
	return JSON.parse(text.text);
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-manage-agent-"));
	mkdirSync(join(stateDir, "agents"), { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("manage_agent — concurrent-call safety", () => {
	it("5 parallel calls leave process.stdout intact (no captureStdio corruption)", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});
		const tool = makeManageAgentTool();
		const realStdoutWrite = process.stdout.write.bind(process.stdout);
		const realStderrWrite = process.stderr.write.bind(process.stderr);

		// Fire 5 concurrent add calls. Without the serial mutex, the second-
		// to-fire's captureStdio would save the first's hook as "original" and
		// restoring would leave process.stdout permanently broken.
		const results = await Promise.all(
			["alpha", "beta", "gamma", "delta", "epsilon"].map((id) =>
				tool.execute(`call-${id}`, { action: "add", id }),
			),
		);

		// CRITICAL: process.stdout.write must be the real one after all the
		// concurrent calls settle. If the race fired, it would be one of the
		// orphaned capture closures.
		assert.strictEqual(
			process.stdout.write.bind(process.stdout).toString(),
			realStdoutWrite.toString(),
			"process.stdout.write was not properly restored after concurrent calls",
		);
		assert.strictEqual(
			process.stderr.write.bind(process.stderr).toString(),
			realStderrWrite.toString(),
			"process.stderr.write was not properly restored after concurrent calls",
		);

		// All 5 calls must have completed (ok or expected failure — but no
		// hang and no rejection).
		assert.equal(results.length, 5);
		for (const r of results) {
			assert.ok(r.content);
		}
	});

	it("a failing call does not poison the serial chain", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
				existing: {},
			},
		});
		const tool = makeManageAgentTool();

		// First call: try to ADD an id that already exists (likely fails or
		// errors inside runAgentsAdd). Second call should still succeed.
		const first = tool.execute("call-1", { action: "add", id: "existing" });
		const second = tool.execute("call-2", { action: "add", id: "fresh-one" });

		// Both should resolve — the second must not be blocked or rejected by
		// the first's failure.
		const [, secondResult] = await Promise.all([first.catch(() => null), second]);
		assert.ok(secondResult.content, "second call must complete even if first errored");
	});
});

/**
 * Auto-allowlist seed on `manage_agent({action:"add"})`:
 *
 * Without this UX bridge, a fresh `manage_agent` call writes the new agent
 * into `cfg.agents.<id>` but never updates `cfg.agents.defaults.subagents.
 * allowAgents` — so the allowlist-scoped `agents_list` tool keeps returning
 * only the requester, and the model has no way to learn the catalog.
 *
 * These tests pin the contract:
 *   (a) add seeds `defaults.subagents.allowAgents` and the new id surfaces
 *       in `agents_list`
 *   (b) wildcard `"*"` short-circuits the seed (already covers everything)
 *   (c) duplicate-id seed is idempotent (no double-write)
 *   (d) delete strips the id back out of the allowlist
 *   (e) `autoAllowOnCreate: false` opts the operator out for strict-
 *       allowlist mode
 *   (f) per-agent `subagents.allowAgents` override is left untouched (the
 *       seed only touches `defaults.subagents.allowAgents`)
 */
describe("manage_agent — auto-allowlist seed on add", () => {
	it("(a) add seeds defaults.subagents.allowAgents and the new id surfaces in agents_list", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		const res = await tool.execute("call-add", { action: "add", id: "netpulse" });
		assert.ok(res.content);

		// Config now carries `netpulse` in the defaults allowlist.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["netpulse"], "defaults.subagents.allowAgents must contain the new id");

		// agents_list (allowlist-scoped) now surfaces netpulse to the main caller.
		const listed = await runListTool("main");
		const ids = listed.agents.map((a) => a.id);
		assert.ok(ids.includes("main"), "requester always first");
		assert.ok(ids.includes("netpulse"), "newly added agent must appear in agents_list");
	});

	it("(b) wildcard '*' in allowAgents short-circuits the seed", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["*"] },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "support" });

		// The wildcard list must NOT have been extended.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["*"], "wildcard list left intact — seed must skip");
	});

	it("(c) seed is idempotent when the id is already in allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["scout"] },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "scout" });

		// Only ONE entry — no double-write.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["scout"], "idempotent — no duplicate seed");
	});

	it("(d) delete strips the id from defaults.subagents.allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["scout", "netpulse"] },
				},
				main: {},
				scout: { workspace: join(stateDir, "agents", "scout", "workspace") },
				netpulse: {},
			},
		});
		mkdirSync(join(stateDir, "agents", "scout", "workspace"), { recursive: true });

		const tool = makeManageAgentTool();
		await tool.execute("call-del", { action: "delete", id: "scout" });

		// scout must be stripped, netpulse must remain.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["netpulse"], "delete must strip the id from the allowlist");
	});

	it("(e) autoAllowOnCreate=false suppresses the seed (strict-allowlist mode)", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: [], autoAllowOnCreate: false },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "stealth" });

		// Operator-driven allowlist stays empty — model must not see the new agent.
		const allow = readAllowAgents();
		assert.deepEqual(allow, [], "autoAllowOnCreate=false must suppress the seed");

		const listed = await runListTool("main");
		const ids = listed.agents.map((a) => a.id);
		assert.ok(!ids.includes("stealth"), "stealth must NOT surface in agents_list under strict mode");
	});

	it("(f) per-agent subagents.allowAgents override is left untouched", async () => {
		// A peer (`captain`) has its OWN per-agent allowlist. The seed only
		// touches `defaults.subagents.allowAgents`, never the per-agent one,
		// so captain's allowlist must stay exactly as the operator authored it.
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
				captain: { subagents: { allowAgents: ["specific-peer"] } },
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "recruit" });

		// Defaults got the seed.
		const allowDefaults = readAllowAgents();
		assert.deepEqual(allowDefaults, ["recruit"], "defaults gets the new id");

		// Captain's per-agent allowlist untouched.
		const cfg = readCfg();
		const captain = (cfg.agents as Record<string, { subagents?: { allowAgents?: unknown } }>)
			.captain;
		assert.deepEqual(
			captain?.subagents?.allowAgents,
			["specific-peer"],
			"per-agent override must NOT be modified by the seed",
		);

		// agents_list called by captain still only sees `specific-peer` — the
		// per-agent override beats defaults, so `recruit` is hidden from captain.
		const captainView = await runListTool("captain");
		const captainSees = captainView.agents.map((a) => a.id);
		assert.ok(!captainSees.includes("recruit"), "captain must not see recruit (per-agent override wins)");
	});
});
