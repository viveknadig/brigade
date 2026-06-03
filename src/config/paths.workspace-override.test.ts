/**
 * C2: per-agent workspace override must be honoured by the runtime helper.
 *
 * The bug was that runResilientTurn never forwarded the per-agent
 * `cfg.agents[id].workspace` override to runSingleTurn -> resolveAgentWorkspaceDir.
 * This test guards the resolver signature contract (the boot path + server
 * pass-through both rely on the override winning over the default path).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "brigade-paths-ws-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("paths: resolveAgentWorkspaceDir override (C2)", () => {
	it("returns the override verbatim when provided", async () => {
		const { resolveAgentWorkspaceDir } = await import("./paths.js");
		const custom = path.join(stateDir, "custom-ws");
		const resolved = resolveAgentWorkspaceDir("scout", custom);
		assert.equal(resolved, path.resolve(custom));
	});

	it("falls back to default per-agent path when no override is given", async () => {
		const { resolveAgentWorkspaceDir } = await import("./paths.js");
		const resolved = resolveAgentWorkspaceDir("scout");
		assert.ok(resolved.includes(path.join("agents", "scout", "workspace")));
	});
});
