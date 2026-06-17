import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { wipeLocalBrigadeState } from "./factory-reset.js";

/**
 * The factory-reset primitive — the one destructive op behind "Start fresh" /
 * `store reset`. Tested in isolation so the dangerous part is pinned: it wipes
 * the WHOLE local state dir (so a re-onboard is virgin), is idempotent, and
 * NEVER reaches outside the state dir (the encryption key lives there).
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-freset-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("wipeLocalBrigadeState", () => {
	it("removes the entire local state dir — workspace, skills, sessions, facts, sentinel", () => {
		fs.mkdirSync(path.join(dir, "workspace", "memory"), { recursive: true });
		fs.writeFileSync(path.join(dir, "workspace", "AGENTS.md"), "persona edits");
		fs.writeFileSync(path.join(dir, "workspace", "memory", "facts.jsonl"), '{"memoryId":"x"}\n');
		fs.mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
		fs.writeFileSync(path.join(dir, "skills", "demo", "SKILL.md"), "a skill");
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(dir, "mode.sentinel"), '{"mode":"filesystem"}');

		const cleared = wipeLocalBrigadeState(dir);
		assert.equal(cleared, dir);
		assert.equal(fs.existsSync(dir), false, "whole state dir gone — next onboard starts virgin");
	});

	it("is idempotent — wiping a missing dir does not throw", () => {
		assert.doesNotThrow(() => wipeLocalBrigadeState(path.join(dir, "does-not-exist")));
	});

	it("does NOT touch anything OUTSIDE the state dir (the OS-config encryption key survives)", () => {
		const osConfig = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-oscfg-"));
		const keyPath = path.join(osConfig, "encryption.key");
		fs.writeFileSync(keyPath, "deadbeef");
		try {
			fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
			wipeLocalBrigadeState(dir);
			assert.equal(fs.existsSync(keyPath), true, "a key outside the state dir is not destroyed by the wipe");
		} finally {
			fs.rmSync(osConfig, { recursive: true, force: true });
		}
	});
});
