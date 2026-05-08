import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";

// We have to set HOME *before* importing the module under test, because
// `BRIGADE_DIR` is computed at module-load time. Node's ESM cache doesn't
// honor `?t=...` query strings, so we point HOME at a single shared tempdir
// for the whole file, then reset on-disk state + in-memory cache between
// tests via `_resetApprovalsCacheForTests` and `fs.rm`.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-approvals-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBrigadeHome = process.env.BRIGADE_HOME;

process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome; // Windows-equivalent
delete process.env.BRIGADE_HOME;

// Static import works now that HOME is set.
const mod = await import("./exec-approvals.js");

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		if (originalBrigadeHome !== undefined) process.env.BRIGADE_HOME = originalBrigadeHome;
		else delete process.env.BRIGADE_HOME;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	mod._resetApprovalsCacheForTests();
	const file = mod.getApprovalsFilePath();
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* ignore */
	}
});

afterEach(() => {
	mod._resetApprovalsCacheForTests();
});

describe("decideApproval — hard-deny patterns", () => {
	it("blocks rm -rf /", () => {
		assert.equal(mod.decideApproval("rm -rf /"), "deny");
		assert.equal(mod.decideApproval("rm -rf / "), "deny");
		assert.equal(mod.decideApproval("rm -fr /"), "deny");
		assert.equal(mod.decideApproval("rm --recursive --force /"), "deny");
	});

	it("blocks dd to raw disks", () => {
		assert.equal(mod.decideApproval("dd if=/dev/zero of=/dev/sda"), "deny");
		assert.equal(mod.decideApproval("dd if=foo.iso of=/dev/nvme0n1"), "deny");
	});

	it("blocks fork bomb", () => {
		assert.equal(mod.decideApproval(":(){ :|:& };:"), "deny");
	});

	it("blocks mkfs on raw disk", () => {
		assert.equal(mod.decideApproval("mkfs.ext4 /dev/sdb1"), "deny");
	});

	it("does NOT block legitimate rm in a project", () => {
		assert.equal(mod.decideApproval("rm -rf node_modules"), "prompt");
		assert.equal(mod.decideApproval("rm dist/foo.js"), "prompt");
	});
});

describe("decideApproval — allowlist", () => {
	it("returns prompt for unknown commands", () => {
		assert.equal(mod.decideApproval("ls -la"), "prompt");
	});

	it("allows exact-match approved commands", () => {
		mod.recordApproval("ls -la", "exact");
		assert.equal(mod.decideApproval("ls -la"), "allow");
		// Whitespace difference still resolves via trim.
		assert.equal(mod.decideApproval("  ls -la  "), "allow");
	});

	it("allows pattern-match approved commands", () => {
		mod.recordApproval("^git (status|diff|log)( |$)", "pattern");
		assert.equal(mod.decideApproval("git status"), "allow");
		assert.equal(mod.decideApproval("git diff HEAD"), "allow");
		assert.equal(mod.decideApproval("git log --oneline"), "allow");
		assert.equal(mod.decideApproval("git push"), "prompt");
	});

	it("hard-deny beats allowlist (rm -rf / cannot be approved)", () => {
		mod.recordApproval("rm -rf /", "exact");
		assert.equal(mod.decideApproval("rm -rf /"), "deny");
	});

	it("malformed regex pattern is skipped, not crashed", () => {
		mod.recordApproval("[unclosed", "pattern");
		assert.equal(mod.decideApproval("foo"), "prompt");
	});
});

describe("recordApproval — persistence", () => {
	it("writes to disk + reloads on cache reset", () => {
		mod.recordApproval("npm test", "exact");
		assert.equal(mod.decideApproval("npm test"), "allow");
		// Drop the cache and read again — should reload from disk.
		mod._resetApprovalsCacheForTests();
		assert.equal(mod.decideApproval("npm test"), "allow");
	});

	it("dedupes repeated approvals", () => {
		mod.recordApproval("ls", "exact");
		mod.recordApproval("ls", "exact");
		mod.recordApproval("ls", "exact");
		const filePath = mod.getApprovalsFilePath();
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { commands: string[] };
		assert.equal(parsed.commands.filter((c: string) => c === "ls").length, 1);
	});

	it("ignores empty / whitespace-only approvals", () => {
		mod.recordApproval("   ", "exact");
		mod.recordApproval("", "exact");
		assert.equal(mod.decideApproval("   "), "prompt");
	});
});
