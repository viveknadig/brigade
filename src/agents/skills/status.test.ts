/**
 * Tests for the skill-status reporter behind the `skills.status` RPC.
 *
 * Verifies the report shape (workspaceDir, managedSkillsDir, skills[])
 * and that source buckets (bundled, managed, personal, project,
 * workspace) all surface through the report.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildSkillStatusReport } from "./status.js";
import { clearBinaryCache } from "./eligibility.js";

let root: string;
let prevState: string | undefined;
let prevBundled: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let homeDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-status-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevBundled = process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	prevHome = process.env.HOME;
	prevUserProfile = process.env.USERPROFILE;
	process.env.BRIGADE_STATE_DIR = path.join(root, "state");
	process.env.BRIGADE_BUNDLED_SKILLS_DIR = path.join(root, "no-bundled"); // empty
	homeDir = path.join(root, "home");
	process.env.HOME = homeDir;
	// `os.homedir()` reads USERPROFILE on win32; set both so the personal-dir
	// resolution in `~/.agents/skills` lands under our tmp root on every host.
	process.env.USERPROFILE = homeDir;
	fs.mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
	clearBinaryCache();
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevBundled === undefined) delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	else process.env.BRIGADE_BUNDLED_SKILLS_DIR = prevBundled;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = prevUserProfile;
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeSkill(base: string, name: string, description: string): void {
	const dir = path.join(base, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`,
		"utf8",
	);
}

describe("buildSkillStatusReport", () => {
	it("returns the canonical shape with workspaceDir + managedSkillsDir + skills[]", () => {
		const workspaceDir = path.join(root, "ws");
		fs.mkdirSync(workspaceDir, { recursive: true });
		writeSkill(path.join(workspaceDir, "skills"), "alpha", "Alpha skill.");
		const report = buildSkillStatusReport({ workspaceDir, config: {} });
		assert.equal(report.workspaceDir, workspaceDir);
		assert.equal(typeof report.managedSkillsDir, "string");
		assert.ok(Array.isArray(report.skills));
		assert.equal(report.skills.length, 1);
		const entry = report.skills[0]!;
		assert.equal(entry.name, "alpha");
		assert.equal(entry.source, "workspace");
		assert.equal(entry.eligible, true);
		assert.equal(entry.disabled, false);
		assert.equal(entry.blockedByAllowlist, false);
		assert.deepEqual(entry.missing, {});
	});

	it("reports source buckets for managed / personal / project / workspace skills", () => {
		const workspaceDir = path.join(root, "ws");
		fs.mkdirSync(workspaceDir, { recursive: true });
		writeSkill(path.join(process.env.BRIGADE_STATE_DIR!, "skills"), "from-managed", "m");
		writeSkill(path.join(homeDir, ".agents", "skills"), "from-personal", "p");
		writeSkill(path.join(workspaceDir, ".agents", "skills"), "from-project", "pr");
		writeSkill(path.join(workspaceDir, "skills"), "from-ws", "w");
		const report = buildSkillStatusReport({ workspaceDir, config: {} });
		const map = new Map(report.skills.map((s) => [s.name, s.source]));
		assert.equal(map.get("from-managed"), "managed");
		assert.equal(map.get("from-personal"), "agents-skills-personal");
		assert.equal(map.get("from-project"), "agents-skills-project");
		assert.equal(map.get("from-ws"), "workspace");
	});

	it("marks a skill blockedByAllowlist when per-agent skills filter hides it", () => {
		const workspaceDir = path.join(root, "ws");
		fs.mkdirSync(workspaceDir, { recursive: true });
		writeSkill(path.join(workspaceDir, "skills"), "alpha", "a");
		writeSkill(path.join(workspaceDir, "skills"), "beta", "b");
		const report = buildSkillStatusReport({
			workspaceDir,
			agentId: "ops",
			config: { agents: { ops: { skills: ["alpha"] } } } as never,
		});
		const alpha = report.skills.find((s) => s.name === "alpha");
		const beta = report.skills.find((s) => s.name === "beta");
		assert.ok(alpha && beta);
		assert.equal(alpha!.blockedByAllowlist, false);
		assert.equal(beta!.blockedByAllowlist, true);
		assert.equal(beta!.eligible, false);
	});

	it("marks an OS-ineligible skill with missing.os populated", () => {
		const workspaceDir = path.join(root, "ws");
		fs.mkdirSync(workspaceDir, { recursive: true });
		const dir = path.join(workspaceDir, "skills", "maconly");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: maconly\ndescription: mac\nos: macos\n---\nBody.\n`,
			"utf8",
		);
		const report = buildSkillStatusReport({
			workspaceDir,
			config: {},
			platform: "linux",
			env: { PATH: "" },
		});
		const entry = report.skills[0]!;
		assert.equal(entry.eligible, false);
		assert.deepEqual(entry.missing.os, ["linux"]);
		assert.deepEqual(entry.requirements.os, ["darwin"]);
	});
});
