import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// Point HOME at a per-test-file tempdir BEFORE the under-test modules
// resolve `BRIGADE_DIR` (which they pin at import time). exec-approvals
// reads/writes `<HOME>/.brigade/exec-approvals.json`; without this the
// workspace-jail bash-decision tests would clobber the operator's real
// allowlist.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-jail-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBrigadeHome = process.env.BRIGADE_HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const { decideApproval: _ensureLoaded, recordApproval, getApprovalsFilePath, _resetApprovalsCacheForTests } =
	await import("../core/exec-approvals.js");
// Marker reference so eslint doesn't complain about unused import.
void _ensureLoaded;

const {
	isPathInsideWorkspace,
	isPathInsideWorkspaceWithAlias,
	makeWorkspaceJailGuard,
	resolveAgainstWorkspace,
} = await import("./workspace-jail.js");

const WS = path.resolve("/tmp/.brigade/workspace");

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
	// Each bash-decision test starts from an empty allowlist so behaviour
	// is reproducible regardless of file order.
	_resetApprovalsCacheForTests();
	try {
		fs.rmSync(getApprovalsFilePath(), { force: true });
	} catch {
		/* ignore */
	}
});

describe("isPathInsideWorkspace", () => {
	it("treats workspace root itself as inside", () => {
		assert.equal(isPathInsideWorkspace(WS, WS), true);
	});

	it("accepts a relative path that lands inside the workspace", () => {
		assert.equal(isPathInsideWorkspace("USER.md", WS), true);
		assert.equal(isPathInsideWorkspace("memory/notes.md", WS), true);
	});

	it("accepts an absolute path inside the workspace", () => {
		assert.equal(isPathInsideWorkspace(path.join(WS, "IDENTITY.md"), WS), true);
	});

	it("rejects an absolute path outside the workspace", () => {
		assert.equal(isPathInsideWorkspace("/etc/passwd", WS), false);
		assert.equal(isPathInsideWorkspace("/tmp/elsewhere/file.md", WS), false);
	});

	it("rejects relative paths that traverse outside via ..", () => {
		assert.equal(isPathInsideWorkspace("../escape.md", WS), false);
		assert.equal(isPathInsideWorkspace("../../etc/passwd", WS), false);
	});

	it("rejects mixed traversal that resolves outside", () => {
		// foo/../../escape resolves to one level above WS
		assert.equal(isPathInsideWorkspace("foo/../../escape.md", WS), false);
	});

	it("accepts redundant traversal that resolves back inside", () => {
		// foo/../USER.md normalises to USER.md → inside
		assert.equal(isPathInsideWorkspace("foo/../USER.md", WS), true);
	});
});

describe("resolveAgainstWorkspace", () => {
	it("resolves relative paths against the workspace root", () => {
		assert.equal(resolveAgainstWorkspace("USER.md", WS), path.resolve(WS, "USER.md"));
	});

	it("preserves absolute paths", () => {
		assert.equal(resolveAgainstWorkspace("/abs/path.md", WS), path.resolve("/abs/path.md"));
	});

	it("falls back to workspace root for empty input", () => {
		assert.equal(resolveAgainstWorkspace("", WS), path.resolve(WS));
	});
});

describe("makeWorkspaceJailGuard", () => {
	it("returns undefined for unrelated tool names", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "read", arguments: { path: "/etc/hosts" } } } as never);
		assert.equal(r, undefined);
	});

	it("BLOCKS bash with a 'prompt' decision (command not on allowlist)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /not on the exec-approvals allowlist/);
		assert.match(r?.reason ?? "", /brigade exec allow/);
	});

	it("BLOCKS bash with a 'deny' decision (hard-deny pattern)", async () => {
		// Hard-deny patterns are caught at the gate regardless of allowlist
		// state. (recordApproval refuses to store hard-denied commands —
		// covered separately in exec-approvals.test.ts — so the only way a
		// "rm -rf /" reaches the gate is via the model's tool call itself.)
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "rm -rf /" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /hard-deny pattern/);
	});

	it("ALLOWS bash when the command is on the exec-approvals allowlist", async () => {
		recordApproval("ls -la", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls -la" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("ALLOWS bash via pattern allowlist", async () => {
		recordApproval("^git (status|diff)( |$)", "pattern");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "git status" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("BLOCKS bash with empty command (treated as prompt)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "bash", arguments: { command: "" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /not on the exec-approvals allowlist/);
	});

	it("accepts bash command under 'cmd' or 'script' fallback arg key (provider variation)", async () => {
		recordApproval("echo hi", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const a = await guard({ toolCall: { name: "bash", arguments: { cmd: "echo hi" } } } as never);
		assert.equal(a, undefined);
		const b = await guard({ toolCall: { name: "bash", arguments: { script: "echo hi" } } } as never);
		assert.equal(b, undefined);
	});

	it("blocks write to a path outside the workspace", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "/etc/escape.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /outside the workspace/);
	});

	it("blocks write to a path that traverses out via ..", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "../../escape.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("blocks edit outside the workspace too", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "edit", arguments: { path: "/somewhere/else.md", oldText: "a", newText: "b" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("allows write with a relative path WHEN the agent cwd is inside the workspace", async () => {
		// Pi resolves relative paths against `processCwd`, so when the agent
		// is running with cwd = workspace, "USER.md" lands inside.
		const guard = makeWorkspaceJailGuard(WS, WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "USER.md", content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("BLOCKS write with a relative path when agent cwd is OUTSIDE the workspace (the Claude bug)", async () => {
		// Real-world: agent runs from F:\Brigade (the source tree), workspace is
		// ~/.brigade/workspace. Claude emits write({path: "USER.md"}). Pi
		// resolves "USER.md" against F:\Brigade — outside the workspace. The
		// jail must catch this. The earlier (broken) jail let it through
		// because it resolved the path against the workspace, not against cwd.
		const projectCwd = path.resolve("/tmp/some-project");
		const guard = makeWorkspaceJailGuard(WS, projectCwd);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "USER.md", content: "..." } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /outside the workspace/);
		assert.match(r?.reason ?? "", /Retry with the absolute path/);
	});

	it("allows write with an absolute path inside the workspace (cwd irrelevant)", async () => {
		const projectCwd = path.resolve("/tmp/anywhere");
		const guard = makeWorkspaceJailGuard(WS, projectCwd);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: path.join(WS, "IDENTITY.md"), content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("ignores write calls with no path arg (let downstream handle)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("does not interfere with read/grep/find/ls (kept open in v1)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		for (const name of ["read", "grep", "find", "ls"]) {
			const r = await guard({
				toolCall: { name, arguments: { path: "/etc/passwd" } },
			} as never);
			assert.equal(r, undefined, `${name} should pass through`);
		}
	});

	it("trims whitespace from tool name (defence in depth — '  bash  ' still routes through exec-approvals)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "  bash  ", arguments: { command: "ls" } },
		} as never);
		// "ls" isn't on the allowlist, so the exec-approvals gate refuses
		// — the test's point is that the trim+match worked, not that bash
		// is always blocked.
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /not on the exec-approvals allowlist/);
	});

	it("blocks Windows UNC paths (\\\\server\\share)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "\\\\attacker\\share\\loot.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /UNC.*paths/i);
	});

	it("blocks POSIX-style network paths (//host/share)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "//host/share/file.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("normalizes Unicode whitespace inside path arguments", async () => {
		// Pass cwd = workspace so the relative path resolves inside the
		// boundary; this test is about whitespace normalization, not the
		// cwd-vs-workspace check (covered in its own test above).
		const guard = makeWorkspaceJailGuard(WS, WS);
		const sneaky = "USER .md"; // NBSP between USER and .md
		const r = await guard({
			toolCall: { name: "write", arguments: { path: sneaky, content: "x" } },
		} as never);
		assert.equal(r, undefined);
	});
});

describe("isPathInsideWorkspace edge cases", () => {
	it("rejects UNC paths outright", () => {
		assert.equal(isPathInsideWorkspace("\\\\server\\share\\file", WS), false);
		assert.equal(isPathInsideWorkspace("//host/path", WS), false);
	});
});

describe("isPathInsideWorkspaceWithAlias — symlink escape detection", () => {
	let tmpRoot: string;
	let tmpWs: string;
	let outsideTarget: string;
	let symlinkSupported = true;

	before(async () => {
		tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "brigade-jail-"));
		tmpWs = path.join(tmpRoot, "workspace");
		await fsp.mkdir(tmpWs);
		outsideTarget = path.join(tmpRoot, "secret.txt");
		await fsp.writeFile(outsideTarget, "secret");
		// Probe whether we can create symlinks (Windows requires admin or Dev Mode).
		try {
			const probe = path.join(tmpRoot, "_probe");
			await fsp.symlink(outsideTarget, probe);
			await fsp.unlink(probe);
		} catch {
			symlinkSupported = false;
		}
	});

	after(async () => {
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	it("accepts a normal path inside the workspace", async () => {
		const ok = await isPathInsideWorkspaceWithAlias("USER.md", tmpWs);
		assert.equal(ok, true);
	});

	it("rejects an absolute path outside the workspace (no symlink involved)", async () => {
		const ok = await isPathInsideWorkspaceWithAlias(outsideTarget, tmpWs);
		assert.equal(ok, false);
	});

	it("rejects a path that lexically matches but realpath-resolves outside (symlink alias escape)", async (t) => {
		if (!symlinkSupported) {
			t.skip("symlink creation not permitted on this host (Windows Dev Mode required)");
			return;
		}
		const sneaky = path.join(tmpWs, "USER.md");
		await fsp.symlink(outsideTarget, sneaky);
		try {
			const ok = await isPathInsideWorkspaceWithAlias("USER.md", tmpWs);
			assert.equal(ok, false, "alias escape MUST be rejected");
		} finally {
			await fsp.unlink(sneaky).catch(() => {});
		}
	});

	it("accepts a path that doesn't exist yet (broken-symlink-style — ancestor walk works)", async () => {
		const ok = await isPathInsideWorkspaceWithAlias("brand-new-file.md", tmpWs);
		assert.equal(ok, true);
	});
});

const busMod = await import("./agent-event-bus.js");

describe("workspace-jail — exec-gated tool names", () => {
	it("gates 'exec', 'shell', 'sh' the same way as 'bash'", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		for (const toolName of ["exec", "shell", "sh"]) {
			const r = await guard({
				toolCall: { name: toolName, arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true, `${toolName} should be gated`);
			assert.match(r?.reason ?? "", /exec-approvals allowlist/);
		}
	});

	it("accepts the canonical bash with its allowed command", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r, undefined);
	});
});

describe("workspace-jail — workdir refusal", () => {
	it("refuses bash with a non-empty `workdir` even when the command is allowlisted", async () => {
		recordApproval("ls -la", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls -la", workdir: "/etc" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /override .* is not allowed/);
		assert.match(r?.reason ?? "", /\/etc/);
	});

	it("refuses bash with a non-empty `cwd` (provider alias for workdir)", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", cwd: "/tmp/elsewhere" } },
		} as never);
		assert.equal(r?.block, true);
		// Either workdir or cwd key — both refuse via the same shape
		assert.match(r?.reason ?? "", /workdir|cwd/);
	});

	it("allows bash when `workdir` is empty / whitespace-only", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const a = await guard({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "" } } } as never);
		assert.equal(a, undefined);
		const b = await guard({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "  " } } } as never);
		assert.equal(b, undefined);
	});
});

describe("workspace-jail — tool-blocked bus events", () => {
	beforeEach(() => {
		busMod.__resetAgentBusForTests();
	});

	it("emits tool-blocked for an unapproved bash with runId+agentId from ctxRef", async () => {
		const observed: Array<{ toolName: string; reason: string; runId: string; agentId: string }> = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") {
				observed.push({ toolName: e.toolName, reason: e.reason, runId: e.runId, agentId: e.agentId });
			}
		});
		const ctxRef = { value: { runId: "turn-42", agentId: "main" } };
		const guard = makeWorkspaceJailGuard(WS, process.cwd(), ctxRef);
		await guard({ toolCall: { name: "bash", arguments: { command: "ls -la" } } } as never);
		assert.equal(observed.length, 1);
		assert.equal(observed[0]?.toolName, "bash");
		assert.equal(observed[0]?.runId, "turn-42");
		assert.equal(observed[0]?.agentId, "main");
		assert.match(observed[0]?.reason ?? "", /exec-approvals/);
	});

	it("emits tool-blocked for hard-deny too", async () => {
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const guard = makeWorkspaceJailGuard(WS);
		await guard({ toolCall: { name: "bash", arguments: { command: "rm -rf /" } } } as never);
		assert.equal(observed.length, 1);
		assert.match(observed[0] ?? "", /hard-deny pattern/);
	});

	it("emits tool-blocked for workdir refusal", async () => {
		recordApproval("ls", "exact");
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const guard = makeWorkspaceJailGuard(WS);
		await guard({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc" } } } as never);
		assert.equal(observed.length, 1);
		assert.match(observed[0] ?? "", /workdir/);
	});

	it("emits tool-blocked for write outside workspace too", async () => {
		const observed: Array<{ toolName: string; reason: string }> = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push({ toolName: e.toolName, reason: e.reason });
		});
		const guard = makeWorkspaceJailGuard(WS);
		await guard({
			toolCall: { name: "write", arguments: { path: "/etc/escape.md", content: "x" } },
		} as never);
		assert.equal(observed.length, 1);
		assert.equal(observed[0]?.toolName, "write");
		assert.match(observed[0]?.reason ?? "", /outside the workspace/);
	});

	it("uses empty-string runId/agentId when no ctxRef supplied (back-compat)", async () => {
		const observed: Array<{ runId: string; agentId: string }> = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push({ runId: e.runId, agentId: e.agentId });
		});
		const guard = makeWorkspaceJailGuard(WS);
		await guard({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(observed.length, 1);
		assert.equal(observed[0]?.runId, "");
		assert.equal(observed[0]?.agentId, "");
	});

	it("does NOT emit tool-blocked for an allowed bash call", async () => {
		recordApproval("ls", "exact");
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r, undefined);
		assert.equal(observed.length, 0);
	});
});

describe("workspace-jail — non-string command argument", () => {
	it("rejects bash({command: array}) with a clear 'not a string' message (no '(empty command)' leak)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: ["ls", "-la"] } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /command.*argument.*an array.*not a string/i);
		// Critical: the misleading "(empty command)" placeholder MUST NOT appear.
		assert.doesNotMatch(r?.reason ?? "", /\(empty command\)/);
	});

	it("rejects bash({command: null}) with 'object'-shape message", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: null } },
		} as never);
		// command: null is treated as undefined (caller filtered to {} via ?? coalesce),
		// so this routes to "(empty command)" — that's the literal-empty case.
		// What we want to verify is that null doesn't crash the guard.
		assert.equal(r?.block, true);
	});

	it("rejects bash({command: 42}) with 'number'-shape message", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: 42 } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /number.*not a string/i);
	});

	it("rejects bash({command: {nested: true}}) with 'object'-shape message", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: { nested: true } } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /object.*not a string/i);
	});
});

describe("workspace-jail — workdir type variation", () => {
	it("workdir of non-string type (number) is REFUSED outright with shape info in the reason", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: 42 } },
		} as never);
		// Non-string workdir is now refused regardless of allowlist state.
		// Without this, the model could emit `{workdir: 42}` and bypass the
		// type check, letting Pi pick its own resolution.
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /workdir.*override.*number/i);
	});

	it("workdir of non-string type (object) is also refused", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: { fake: true } } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /workdir.*override.*object/i);
	});

	it("both workdir and cwd set — workdir takes precedence in the message", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc", cwd: "/tmp" } },
		} as never);
		assert.equal(r?.block, true);
		// The message identifies which key triggered the refusal.
		assert.match(r?.reason ?? "", /workdir.*"\/etc"/);
	});

	it("explicit empty-string workdir is treated as no workdir (allows the call through)", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: "" } },
		} as never);
		// Empty-string workdir is harmless — same as omitting the key. The
		// bash gate falls through to decideApproval ("ls" is allowed).
		assert.equal(r, undefined);
	});
});

describe("workspace-jail — env-arg refusal", () => {
	it("refuses bash with a non-empty env object (env hijack defence)", async () => {
		recordApproval("git status", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: {
				name: "bash",
				arguments: { command: "git status", env: { GIT_SSH_COMMAND: "/tmp/evil" } },
			},
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /env.*override.*not allowed/i);
		assert.match(r?.reason ?? "", /GIT_SSH_COMMAND|LD_PRELOAD/);
	});

	it("allows bash when env is an empty object (same as no env)", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", env: {} } },
		} as never);
		assert.equal(r, undefined);
	});

	it("refuses non-object env (number/array)", async () => {
		recordApproval("ls", "exact");
		const guard = makeWorkspaceJailGuard(WS);
		const r1 = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", env: 42 } },
		} as never);
		assert.equal(r1?.block, true);
		const r2 = await guard({
			toolCall: { name: "bash", arguments: { command: "ls", env: ["FOO=bar"] } },
		} as never);
		assert.equal(r2?.block, true);
	});
});

describe("workspace-jail — case-insensitive tool name match", () => {
	it('"Bash" (capitalized) is gated the same as "bash"', async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "Bash", arguments: { command: "ls" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /exec-approvals allowlist/);
	});

	it('"SHELL" / "Exec" / "SH" all trip the gate', async () => {
		const guard = makeWorkspaceJailGuard(WS);
		for (const toolName of ["SHELL", "Exec", "SH"]) {
			const r = await guard({
				toolCall: { name: toolName, arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true, `${toolName} should be gated`);
		}
	});

	it('"Write" / "Edit" (capitalized) are jailed the same as lowercase (round-5 audit fix)', async () => {
		// Regression test for BUG-1 from the final audit: PATH_MUTATING_TOOLS
		// was previously checked against the raw `name` (case-sensitive), so a
		// provider emitting `Write`/`Edit` bypassed the path jail entirely.
		const guard = makeWorkspaceJailGuard(WS);
		for (const toolName of ["Write", "WRITE", "Edit", "EDIT"]) {
			const r = await guard({
				toolCall: { name: toolName, arguments: { path: "/etc/escape.md", content: "x" } },
			} as never);
			assert.equal(r?.block, true, `${toolName} should be jailed`);
			assert.match(r?.reason ?? "", /outside the workspace/);
		}
	});
});

describe("workspace-jail — bus listener safety", () => {
	beforeEach(() => {
		busMod.__resetAgentBusForTests();
	});

	it("throwing listener does NOT crash the guard (block result still returned)", async () => {
		// A listener throws — the bus catches it via process.emitWarning and
		// keeps going. The guard should still return its block result.
		const originalWarning = process.emitWarning;
		process.emitWarning = (() => {}) as never; // swallow the warning in test output
		try {
			busMod.onAgentEvent(() => {
				throw new Error("boom");
			});
			const guard = makeWorkspaceJailGuard(WS);
			const r = await guard({
				toolCall: { name: "bash", arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true);
			assert.match(r?.reason ?? "", /exec-approvals allowlist/);
		} finally {
			process.emitWarning = originalWarning;
		}
	});
});

describe("workspace-jail — schema-version-error passthrough", () => {
	it("decideApproval throwing version-error → guard refuses tool call with a remediation reason", async () => {
		// Plant a future-version file. decideApproval will throw on first read.
		const fs = await import("node:fs");
		fs.writeFileSync(
			getApprovalsFilePath(),
			JSON.stringify({ version: 99, commands: [] }, null, 2),
			"utf8",
		);
		// Also bump mtime so the in-process cache invalidates.
		const future = new Date(Date.now() + 100);
		fs.utimesSync(getApprovalsFilePath(), future, future);
		_resetApprovalsCacheForTests();
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "bash", arguments: { command: "ls" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /schema version/);
		assert.match(r?.reason ?? "", /upgrade Brigade/);
	});
});
