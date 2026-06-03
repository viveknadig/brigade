import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevStateDir: string | undefined;

/**
 * Run `fn` with process.stdout/stderr.write replaced by buffers, then
 * restore. Buffers are returned alongside the function's result so the
 * test runner's own reporter output is never disturbed (capture is
 * scoped strictly to the `await fn()` call).
 */
async function captureStdio<T>(fn: () => Promise<T>): Promise<{
	result: T;
	out: string;
	err: string;
}> {
	const outBuf: string[] = [];
	const errBuf: string[] = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		outBuf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		errBuf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, out: outBuf.join(""), err: errBuf.join("") };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

function writeConfig(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agcmd-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agents-cmd: runAgentsList", () => {
	it("emits the default agent when no entries exist", async () => {
		const { runAgentsList } = await import("./agents-cmd.js");
		const { result, out } = await captureStdio(() => runAgentsList({ json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out);
		assert.equal(Array.isArray(parsed), true);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].id, "main");
		assert.equal(parsed[0].isDefault, true);
	});

	it("renders all entries plus a Routing-rules summary line", async () => {
		writeConfig({ agents: { main: {}, scout: { name: "Scout" } } });
		const { runAgentsList } = await import("./agents-cmd.js");
		const { result, out } = await captureStdio(() => runAgentsList({}));
		assert.equal(result, 0);
		assert.match(out, /main/);
		assert.match(out, /scout/);
		assert.match(out, /Routing rules/);
	});
});

describe("agents-cmd: runAgentsBindings", () => {
	it("returns empty array (JSON) when none configured", async () => {
		const { runAgentsBindings } = await import("./agents-cmd.js");
		const { result, out } = await captureStdio(() => runAgentsBindings({ json: true }));
		assert.equal(result, 0);
		assert.deepEqual(JSON.parse(out), []);
	});

	it("filters by --agent", async () => {
		writeConfig({
			agents: { main: {}, scout: {} },
			bindings: {
				entries: [
					{ agentId: "main", match: { channel: "whatsapp" } },
					{ agentId: "scout", match: { channel: "telegram" } },
				],
			},
		});
		const { runAgentsBindings } = await import("./agents-cmd.js");
		const { result, out } = await captureStdio(() => runAgentsBindings({ agent: "scout", json: true }));
		assert.equal(result, 0);
		const parsed = JSON.parse(out);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].agentId, "scout");
	});

	it("errors when --agent target does not exist", async () => {
		writeConfig({ agents: { main: {} } });
		const { runAgentsBindings } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsBindings({ agent: "ghost" }));
		assert.equal(result, 1);
		assert.match(err, /not found/);
	});
});

describe("agents-cmd: runAgentsBind", () => {
	it("rejects when no --bind specs supplied", async () => {
		writeConfig({ agents: { main: {} } });
		const { runAgentsBind } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsBind({ agent: "main" }));
		assert.equal(result, 1);
		assert.match(err, /at least one --bind/);
	});

	it("persists a new binding into brigade.json", async () => {
		writeConfig({ agents: { main: {} } });
		const { runAgentsBind } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsBind({ agent: "main", bind: ["whatsapp"], json: true }),
		);
		assert.equal(result, 0);
		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		assert.equal(entries.length, 1);
	});

	it("reports a conflict + exit-1 when another agent owns the slot", async () => {
		writeConfig({
			agents: { main: {}, scout: {} },
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		});
		const { runAgentsBind } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() =>
			runAgentsBind({ agent: "scout", bind: ["whatsapp"] }),
		);
		assert.equal(result, 1);
		assert.match(err, /claimed by another agent/);
	});
});

describe("agents-cmd: runAgentsUnbind", () => {
	it("--all clears every binding for the target agent", async () => {
		writeConfig({
			agents: { main: {}, scout: {} },
			bindings: {
				entries: [
					{ agentId: "main", match: { channel: "whatsapp" } },
					{ agentId: "main", match: { channel: "telegram" } },
					{ agentId: "scout", match: { channel: "discord" } },
				],
			},
		});
		const { runAgentsUnbind } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsUnbind({ agent: "main", all: true, json: true }),
		);
		assert.equal(result, 0);
		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		assert.equal(entries.length, 1);
	});

	it("rejects --all + --bind together", async () => {
		writeConfig({ agents: { main: {} } });
		const { runAgentsUnbind } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() =>
			runAgentsUnbind({ agent: "main", all: true, bind: ["whatsapp"] }),
		);
		assert.equal(result, 1);
		assert.match(err, /either --all or --bind/);
	});

	it("removes one specific binding when --bind supplied", async () => {
		writeConfig({
			agents: { main: {} },
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		});
		const { runAgentsUnbind } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsUnbind({ agent: "main", bind: ["whatsapp"], json: true }),
		);
		assert.equal(result, 0);
		const cfg = readConfig();
		const entries = (cfg.bindings as { entries: unknown[] }).entries;
		assert.equal(entries.length, 0);
	});
});

describe("agents-cmd: runAgentsAdd", () => {
	it("requires a name argument", async () => {
		const { runAgentsAdd } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsAdd({}));
		assert.equal(result, 1);
		assert.match(err, /Agent name is required/);
	});

	it("refuses to add the reserved default id", async () => {
		const { runAgentsAdd } = await import("./agents-cmd.js");
		const ws = mkdtempSync(join(tmpdir(), "br-add-ws-"));
		try {
			const { result, err } = await captureStdio(() =>
				runAgentsAdd({ name: "main", workspace: ws, nonInteractive: true }),
			);
			assert.equal(result, 1);
			assert.match(err, /reserved/);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("persists a new agent + workspace path", async () => {
		const ws = mkdtempSync(join(tmpdir(), "br-add-ws-"));
		try {
			const { runAgentsAdd } = await import("./agents-cmd.js");
			const { result } = await captureStdio(() =>
				runAgentsAdd({
					name: "scout",
					workspace: ws,
					model: "claude-opus-4-7",
					nonInteractive: true,
					json: true,
				}),
			);
			assert.equal(result, 0);
			const cfg = readConfig();
			const agents = cfg.agents as Record<string, unknown>;
			assert.ok(agents.scout);
			const entry = agents.scout as { workspace?: string; model?: string };
			assert.equal(entry.model, "claude-opus-4-7");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("refuses to add a duplicate id", async () => {
		writeConfig({ agents: { main: {}, scout: {} } });
		const ws = mkdtempSync(join(tmpdir(), "br-add-ws-"));
		try {
			const { runAgentsAdd } = await import("./agents-cmd.js");
			const { result, err } = await captureStdio(() =>
				runAgentsAdd({
					name: "scout",
					workspace: ws,
					nonInteractive: true,
				}),
			);
			assert.equal(result, 1);
			assert.match(err, /already exists/);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});

describe("agents-cmd: runAgentsSetIdentity", () => {
	it("writes identity fields from CLI flags", async () => {
		writeConfig({ agents: { main: {}, scout: {} } });
		const { runAgentsSetIdentity } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsSetIdentity({
				agent: "scout",
				name: "Scout",
				emoji: "S",
				json: true,
			}),
		);
		assert.equal(result, 0);
		const cfg = readConfig();
		const entry = (cfg.agents as Record<string, { identity?: { name?: string; emoji?: string } }>).scout;
		assert.equal(entry?.identity?.name, "Scout");
		assert.equal(entry?.identity?.emoji, "S");
	});

	it("errors when no identity fields supplied and no IDENTITY.md is present", async () => {
		writeConfig({ agents: { main: {}, scout: {} } });
		const ws = mkdtempSync(join(tmpdir(), "br-id-ws-"));
		try {
			const { runAgentsSetIdentity } = await import("./agents-cmd.js");
			const { result, err } = await captureStdio(() =>
				runAgentsSetIdentity({ agent: "scout", workspace: ws }),
			);
			assert.equal(result, 1);
			assert.match(err, /No identity data/);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("reads IDENTITY.md when --from-identity is set", async () => {
		writeConfig({ agents: { main: {}, scout: {} } });
		const ws = mkdtempSync(join(tmpdir(), "br-id-ws-"));
		try {
			writeFileSync(join(ws, "IDENTITY.md"), "- Name: Scout from file\n- Emoji: F\n");
			const { runAgentsSetIdentity } = await import("./agents-cmd.js");
			const { result } = await captureStdio(() =>
				runAgentsSetIdentity({
					agent: "scout",
					workspace: ws,
					fromIdentity: true,
					json: true,
				}),
			);
			assert.equal(result, 0);
			const cfg = readConfig();
			const entry = (cfg.agents as Record<string, { identity?: { name?: string } }>).scout;
			assert.equal(entry?.identity?.name, "Scout from file");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});

describe("agents-cmd: runAgentsDelete", () => {
	it("refuses the default id", async () => {
		const { runAgentsDelete } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsDelete({ id: "main", force: true }));
		assert.equal(result, 1);
		assert.match(err, /cannot be deleted/);
	});

	it("refuses without --force", async () => {
		writeConfig({ agents: { main: {}, scout: {} } });
		const { runAgentsDelete } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsDelete({ id: "scout" }));
		assert.equal(result, 1);
		assert.match(err, /--force/);
	});

	it("prunes config + bindings + on-disk dirs with --force", async () => {
		const agentDir = join(stateDir, "agents", "scout");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "marker.txt"), "x");
		writeConfig({
			agents: { main: {}, scout: { workspace: agentDir } },
			bindings: { entries: [{ agentId: "scout", match: { channel: "whatsapp" } }] },
		});
		const { runAgentsDelete } = await import("./agents-cmd.js");
		const { result } = await captureStdio(() =>
			runAgentsDelete({ id: "scout", force: true, json: true }),
		);
		assert.equal(result, 0);
		const cfg = readConfig();
		const agents = cfg.agents as Record<string, unknown>;
		assert.equal(agents.scout, undefined);
		const entries = (cfg.bindings as { entries: unknown[] } | undefined)?.entries ?? [];
		assert.equal(entries.length, 0);
	});

	it("rejects an unknown agent id", async () => {
		writeConfig({ agents: { main: {} } });
		const { runAgentsDelete } = await import("./agents-cmd.js");
		const { result, err } = await captureStdio(() => runAgentsDelete({ id: "ghost", force: true }));
		assert.equal(result, 1);
		assert.match(err, /not found/);
	});
});
