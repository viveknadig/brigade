import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveAgentWorkspaceDir } from "../../config/paths.js";
import { LocalSkillStore } from "./skill-store.js";

/**
 * Per-agent WORKSPACE skill isolation — the mechanism `store migrate` (S3) relies
 * on to copy each agent's workspace skills, not just main's. A workspace skill is
 * stored under its agent's own workspace dir and is listable only by pointing the
 * list at that dir; the MANAGED scope is a single shared root visible to all.
 */

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: a test skill\n---\n# ${name}\nbody\n`;

let dir: string;
let savedStateDir: string | undefined;
let savedProfile: string | undefined;
beforeEach(() => {
	savedStateDir = process.env.BRIGADE_STATE_DIR;
	savedProfile = process.env.BRIGADE_PROFILE;
	delete process.env.BRIGADE_PROFILE; // ensure default-profile path resolution
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-skills-"));
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(() => {
	if (savedStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = savedStateDir;
	if (savedProfile === undefined) delete process.env.BRIGADE_PROFILE;
	else process.env.BRIGADE_PROFILE = savedProfile;
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("LocalSkillStore — per-agent workspace skills (migrate S3 mechanism)", () => {
	it("workspace skills are isolated PER AGENT; managed is a shared root", async () => {
		const store = new LocalSkillStore(dir);
		await store.write({ scope: "workspace", agentId: "researcher", name: "r-skill", content: skillMd("r-skill") });
		await store.write({ scope: "workspace", agentId: "main", name: "m-skill", content: skillMd("m-skill") });
		await store.write({ scope: "managed", name: "mgr-skill", content: skillMd("mgr-skill") });

		const researcher = (await store.list({ workspaceDir: resolveAgentWorkspaceDir("researcher") })).records;
		const rWorkspace = new Set(researcher.filter((r) => r.source === "workspace").map((r) => r.name));
		assert.ok(rWorkspace.has("r-skill"), "researcher's own workspace skill is listed");
		assert.ok(!rWorkspace.has("m-skill"), "main's workspace skill does NOT leak into researcher's list");

		const main = (await store.list({ workspaceDir: resolveAgentWorkspaceDir("main") })).records;
		const mWorkspace = new Set(main.filter((r) => r.source === "workspace").map((r) => r.name));
		assert.ok(mWorkspace.has("m-skill"), "main's workspace skill is listed");
		assert.ok(!mWorkspace.has("r-skill"), "researcher's skill does NOT leak into main's list");

		// MANAGED is a single shared root — visible no matter which agent dir we scan.
		const managedSeen = researcher.filter((r) => r.source === "managed").map((r) => r.name);
		assert.ok(managedSeen.includes("mgr-skill"), "managed skill is shared across agents (not per-workspace)");
	});
});
