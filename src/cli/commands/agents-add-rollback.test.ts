/**
 * H7 — `agents add` must roll back the just-added agent entry when
 * `bootstrapWorkspace` throws. Without the rollback, the operator ends
 * up with a half-created agent that boots up but has no workspace
 * files — a state worse than failing the command outright.
 *
 * To force bootstrapWorkspace to throw, this suite passes a workspace
 * path that points at an EXISTING FILE (not a directory). `bootstrapWorkspace`
 * calls `fs.mkdir(workspaceDir, { recursive: true })` on that path; mkdir
 * rejects with EEXIST/ENOTDIR when a non-directory file already occupies
 * the path. The rollback path then must remove the just-staged
 * `cfg.agents.<id>` entry and surface the original error message.
 *
 * Tempdir-isolated; never writes into ~/.brigade or ~/.pi.
 */

import { strict as assert } from "node:assert";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevStateDir: string | undefined;
let prevConfigPath: string | undefined;

async function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
	const errBuf: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errBuf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, err: errBuf.join("") };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-rollback-"));
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

describe("agents add: H7 bootstrap rollback", () => {
	it("(a)+(b) rolls back cfg.agents.<id> when bootstrap throws", async () => {
		// Force bootstrapWorkspace to throw by pointing the workspace path
		// at an existing FILE. fs.mkdir on a file-path rejects with EEXIST
		// (POSIX) / ENOTDIR (file-as-dir-parent) depending on platform.
		const wsAsFile = join(stateDir, "scout-workspace.txt");
		writeFileSync(wsAsFile, "this is a file, not a directory");

		// Seed brigade.json with only main so the duplicate-id check passes.
		writeFileSync(
			join(stateDir, "brigade.json"),
			JSON.stringify({ agents: { main: {} } }, null, 2),
		);

		const { runAgentsAdd } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() =>
			runAgentsAdd({
				name: "scout",
				workspace: wsAsFile,
				nonInteractive: true,
			}),
		);

		// (a) The command failed.
		assert.equal(result, 1, "add must return non-zero when bootstrap throws");

		// (c) The error message surfaces the bootstrap failure (rollback path
		// prefixes it with "failed to bootstrap workspace, rolled back agent").
		assert.match(
			err,
			/bootstrap|workspace|rolled back/i,
			`expected bootstrap-failure error, got: ${err}`,
		);

		// (b) cfg.agents must NOT contain the just-added agent.
		const cfg = readConfig();
		const agents = (cfg.agents as Record<string, unknown>) ?? {};
		assert.equal(
			agents.scout,
			undefined,
			"scout must have been rolled out of cfg.agents after the bootstrap throw",
		);
	});

	it("does not strand bindings when rollback evicts the half-staged agent", async () => {
		// If --bind is supplied alongside a failing bootstrap, the rollback
		// must also clear any bindings that got staged. `pruneAgentConfig`
		// (called from the catch branch) handles this — verify the entries
		// list has nothing referencing the rolled-back agent.
		const wsAsFile = join(stateDir, "ghost-ws.txt");
		writeFileSync(wsAsFile, "x");
		writeFileSync(
			join(stateDir, "brigade.json"),
			JSON.stringify({ agents: { main: {} } }, null, 2),
		);

		const { runAgentsAdd } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsAdd({
				name: "ghost",
				workspace: wsAsFile,
				bind: ["whatsapp"],
				nonInteractive: true,
			}),
		);
		assert.equal(result, 1);

		const cfg = readConfig();
		const agents = (cfg.agents as Record<string, unknown>) ?? {};
		assert.equal(agents.ghost, undefined, "agent entry must be rolled back");
		const entries = (cfg.bindings as { entries?: unknown[] } | undefined)?.entries ?? [];
		for (const entry of entries as Array<{ agentId?: string }>) {
			assert.notEqual(
				entry.agentId,
				"ghost",
				"no binding should remain pointed at the rolled-back agent",
			);
		}
	});
});
