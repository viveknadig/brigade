import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverEligibleSkills } from "./index.js";
import { discoverSkills } from "./discovery.js";
import { clearBinaryCache } from "./eligibility.js";
import { resolveBundledSkillsDir } from "../../config/paths.js";

let root: string;
const prevBundled = process.env.BRIGADE_BUNDLED_SKILLS_DIR;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skills-idx-"));
	// Point the bundled dir at an empty fixture so the facade doesn't pick up
	// the repo's real shipped skills (which would make counts machine-dependent).
	process.env.BRIGADE_BUNDLED_SKILLS_DIR = path.join(root, "no-bundled");
});
afterEach(() => {
	clearBinaryCache();
	if (prevBundled === undefined) delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	else process.env.BRIGADE_BUNDLED_SKILLS_DIR = prevBundled;
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeWorkspaceSkill(workspaceDir: string, name: string, description: string): void {
	const dir = path.join(workspaceDir, "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf8");
}

describe("discoverEligibleSkills (facade)", () => {
	it("discovers workspace skills with an empty config", () => {
		writeWorkspaceSkill(root, "alpha", "Alpha skill.");
		const res = discoverEligibleSkills({ workspaceDir: root, config: {} });
		assert.deepEqual(res.skills.map((s) => s.name), ["alpha"]);
	});

	it("returns nothing when skills are globally disabled", () => {
		writeWorkspaceSkill(root, "alpha", "Alpha skill.");
		const res = discoverEligibleSkills({ workspaceDir: root, config: { skills: { enabled: false } } });
		assert.equal(res.skills.length, 0);
		assert.equal(res.promptBlock, undefined);
	});

	it("honours per-skill disable via config entries", () => {
		writeWorkspaceSkill(root, "alpha", "a");
		writeWorkspaceSkill(root, "beta", "b");
		const res = discoverEligibleSkills({
			workspaceDir: root,
			config: { skills: { entries: { beta: { enabled: false } } } },
		});
		assert.deepEqual(res.skills.map((s) => s.name), ["alpha"]);
	});

	it("discovers skills from config.skills.paths extra roots", () => {
		writeWorkspaceSkill(root, "from-ws", "in workspace");
		// An extra root outside the workspace, wired only via config.skills.paths.
		const extra = path.join(root, "extra-root");
		const dir = path.join(extra, "from-config");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: from-config\ndescription: via config path\n---\nBody.\n", "utf8");
		const res = discoverEligibleSkills({ workspaceDir: root, config: { skills: { paths: [extra] } } });
		assert.deepEqual(res.skills.map((s) => s.name).sort(), ["from-config", "from-ws"]);
	});
});

describe("bundled starter skills (shipped)", () => {
	it("the real bundled dir loads and skill-creator is always eligible", () => {
		// skill-creator declares no eligibility constraints, so it's eligible on
		// every platform regardless of installed binaries. Clear the test-wide
		// bundled override so resolveBundledSkillsDir points at the REAL shipped
		// `<packageRoot>/skills`.
		delete process.env.BRIGADE_BUNDLED_SKILLS_DIR;
		const res = discoverSkills({
			workspaceSkillsDir: path.join(root, "empty-ws"),
			bundledSkillsDir: resolveBundledSkillsDir(),
		});
		const names = res.skills.map((s) => s.name);
		assert.ok(names.includes("skill-creator"), `expected skill-creator in ${JSON.stringify(names)}`);
		assert.ok(res.skills.find((s) => s.name === "skill-creator")?.source === "bundled");
	});
});
