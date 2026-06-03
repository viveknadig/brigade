/**
 * H6 — `agents delete --force` moves the workspace + agent + sessions
 * directories into a sibling `.brigade-trash/` rather than `rm -rf`-ing
 * them outright. A typo on the agent id used to be unrecoverable;
 * trash-and-cap-at-10 gives operators a window to restore by hand.
 *
 * Cap = 10 entries per trash dir (oldest first by ISO-timestamp prefix).
 *
 * Tempdir-isolated; never writes into ~/.brigade or ~/.pi.
 */

import { strict as assert } from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevStateDir: string | undefined;
let prevConfigPath: string | undefined;

async function captureStdio<T>(fn: () => Promise<T>): Promise<T> {
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return await fn();
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

function writeConfig(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-trash-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	prevConfigPath = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = stateDir;
	delete process.env.BRIGADE_CONFIG_PATH;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	if (prevConfigPath === undefined) delete process.env.BRIGADE_CONFIG_PATH;
	else process.env.BRIGADE_CONFIG_PATH = prevConfigPath;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agents delete: H6 trash semantics", () => {
	it("(a) moves the agent dir to <parent>/.brigade-trash/<basename>-<ISO>", async () => {
		// Use the default workspace layout: workspace lives UNDER the agent
		// dir. The delete path safeRm's workspace, agentDir, and sessionsDir
		// in turn — the LAST surviving trash location is the one at the
		// agents-root (where agentDir was moved); the prior workspace-trash
		// got swept into it because agentDir encloses workspace.
		const agentDir = join(stateDir, "agents", "scout");
		const workspaceDir = join(agentDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(workspaceDir, "marker.txt"), "x");
		writeConfig({
			agents: { main: {}, scout: { workspace: workspaceDir } },
		});

		const { runAgentsDelete } = await import("./agents-cmd.js");
		const result = await captureStdio(() =>
			runAgentsDelete({ id: "scout", force: true, json: true }),
		);
		assert.equal(result, 0);

		// (b) Original agent dir + workspace are gone from their original spots.
		assert.equal(existsSync(workspaceDir), false, "original workspace dir must be gone");
		assert.equal(existsSync(agentDir), false, "original agent dir must be gone");

		// (a) Trash directory exists at <agents-root>/.brigade-trash and
		// holds a "scout-<ISO>" entry.
		const trashDir = join(stateDir, "agents", ".brigade-trash");
		assert.equal(existsSync(trashDir), true, "trash dir must exist at the agents root");

		const entries = readdirSync(trashDir);
		const movedScout = entries.find((e) => e.startsWith("scout-"));
		assert.ok(movedScout, "moved scout entry must be timestamped 'scout-<ISO>'");
		// The ISO suffix has colons + dots replaced with dashes (see safeRm).
		assert.match(movedScout, /^scout-\d{4}-\d{2}-\d{2}T/);
	});

	it("(d) strips the deleted id from cfg.agents.defaults.subagents.allowAgents", async () => {
		// pruneAgentConfig must keep the allowlist symmetric with the
		// `applyAutoAllowOnCreate` seed: a deleted agent's id must be
		// removed from both the shared `defaults.subagents.allowAgents`
		// list AND any per-agent override that names it.
		const agentDir = join(stateDir, "agents", "scout");
		const workspaceDir = join(agentDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(workspaceDir, "marker.txt"), "x");
		writeConfig({
			agents: {
				defaults: {
					subagents: { allowAgents: ["scout", "netpulse"] },
				},
				main: {},
				scout: { workspace: workspaceDir },
				netpulse: {
					// Per-agent override that ALSO names scout — both lists must
					// get the symmetric cleanup.
					subagents: { allowAgents: ["scout"] },
				},
			},
		});

		const { runAgentsDelete } = await import("./agents-cmd.js");
		const result = await captureStdio(() =>
			runAgentsDelete({ id: "scout", force: true, json: true }),
		);
		assert.equal(result, 0);

		const cfg = JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8")) as {
			agents: {
				defaults?: { subagents?: { allowAgents?: unknown } };
				netpulse?: { subagents?: { allowAgents?: unknown } };
			};
		};
		// Defaults list: scout removed, netpulse kept.
		assert.deepEqual(
			cfg.agents.defaults?.subagents?.allowAgents,
			["netpulse"],
			"defaults.subagents.allowAgents must drop the deleted id",
		);
		// Per-agent override: scout removed (list now empty array).
		assert.deepEqual(
			cfg.agents.netpulse?.subagents?.allowAgents,
			[],
			"per-agent subagents.allowAgents must also drop the deleted id",
		);
	});

	it("(c) caps trash entries at 10 — the 11th delete evicts the oldest", async () => {
		// Use the AGENT-dir trash slot (one trash dir per agent), which lives
		// at <stateDir>/agents/.brigade-trash/ — only the agent-dir is moved
		// there on each delete since workspace + sessions live under
		// agents/<id>/.brigade-trash respectively. Specifically: agent-dir
		// is at <stateDir>/agents/<id>, so its trash sibling is
		// <stateDir>/agents/.brigade-trash. Each of our 11 deletes will
		// drop one entry into THAT directory.
		const agentsRoot = join(stateDir, "agents");
		mkdirSync(agentsRoot, { recursive: true });
		const trashDir = join(agentsRoot, ".brigade-trash");

		const created: string[] = [];
		for (let i = 0; i < 11; i++) {
			const id = `scout${i}`;
			const wsDir = join(agentsRoot, id, "workspace");
			mkdirSync(wsDir, { recursive: true });
			writeFileSync(join(wsDir, "m.txt"), "x");
			writeConfig({
				agents: { main: {}, [id]: { workspace: wsDir } },
			});
			const { runAgentsDelete } = await import("./agents-cmd.js");
			const result = await captureStdio(() =>
				runAgentsDelete({ id, force: true, json: true }),
			);
			assert.equal(result, 0, `delete #${i} must succeed`);
			created.push(id);
			// Force a 5ms gap so ISO timestamps differ between iterations
			// (otherwise the GC sort can't tell oldest from newest).
			await new Promise((r) => setTimeout(r, 5));
		}

		// The agent-dir trash holds at most 10 entries. The exact basename
		// pattern is `<id>-<ISO>` — the OLDEST one (scout0) must have been
		// evicted by now.
		const entries = readdirSync(trashDir);
		assert.equal(
			entries.length <= 10,
			true,
			`trash dir capped at 10 entries, observed ${entries.length}`,
		);
		const hasOldest = entries.some((e) => e.startsWith("scout0-"));
		assert.equal(hasOldest, false, "oldest entry (scout0) should be evicted");
	});
});
