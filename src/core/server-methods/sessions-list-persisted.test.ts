// `sessions.list` must answer "which threads do I HAVE", not "which are running".
//
// It listed `listLiveSessions()` — the in-memory RUN registry, which empties on every
// gateway restart. So after a restart it reported nothing while a 16 MB conversation
// sat on disk, `/sessions` showed an empty list, and `brigade tui --session <key>`
// refused to open the very thread it was pointed at.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { handleSessionsList } from "./sessions.js";
import { upsertSessionEntry } from "../../sessions/session-store.js";

let tmpRoot: string;
let prevState: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-sesslist-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
});

afterEach(() => {
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

test("a persisted thread is listed even with ZERO live runs (a restarted gateway)", async () => {
	upsertSessionEntry("main", "agent:main:t-0bf7c8e1", { sessionId: "s1", modelId: "claude-opus-4-8" });

	const res = await handleSessionsList({ agentId: "main" });
	const keys = res.sessions.map((s) => s.sessionKey);
	assert.ok(keys.includes("agent:main:t-0bf7c8e1"), `thread missing from ${JSON.stringify(keys)}`);
	assert.equal(res.count, res.sessions.length);
	const row = res.sessions.find((s) => s.sessionKey === "agent:main:t-0bf7c8e1");
	assert.equal(row?.state, "idle", "no run in flight, but the thread exists");
	assert.equal(row?.model, "claude-opus-4-8");
});

test("machinery threads stay hidden — sub-agents and isolated cron runs are not conversations", async () => {
	upsertSessionEntry("main", "agent:main:main", { sessionId: "s0" });
	upsertSessionEntry("main", "agent:main:main:subagent:abc", {
		sessionId: "s2",
		subagent: { parentSessionKey: "agent:main:main", depth: 1 },
	} as never);
	upsertSessionEntry("main", "isolated:cron:nightly", { sessionId: "s3" });

	const keys = (await handleSessionsList({ agentId: "main" })).sessions.map((s) => s.sessionKey);
	assert.deepEqual(keys, ["agent:main:main"], "only the operator's own thread");
});

test("the access guard applies to persisted rows too, not just live ones", async () => {
	upsertSessionEntry("main", "agent:main:secret", { sessionId: "s4" });
	upsertSessionEntry("main", "agent:main:open", { sessionId: "s5" });

	const res = await handleSessionsList(
		{ agentId: "main" },
		{ accessCheck: ({ targetSessionKey }) => ({ allowed: targetSessionKey !== "agent:main:secret" }) },
	);
	const keys = res.sessions.map((s) => s.sessionKey);
	assert.ok(keys.includes("agent:main:open"));
	assert.ok(!keys.includes("agent:main:secret"), "a refused thread must not leak through the persisted path");
});

test("most-recently-used first — the thread you were just in is the one you want", async () => {
	upsertSessionEntry("main", "agent:main:older", { sessionId: "a", lastUsedAt: new Date(1_000).toISOString() });
	upsertSessionEntry("main", "agent:main:newer", { sessionId: "b", lastUsedAt: new Date(9_000).toISOString() });

	const keys = (await handleSessionsList({ agentId: "main" })).sessions.map((s) => s.sessionKey);
	assert.deepEqual(keys, ["agent:main:newer", "agent:main:older"]);
});

test("an unreadable store yields an empty list, never a thrown RPC", async () => {
	// Nothing was ever written for this agent.
	const res = await handleSessionsList({ agentId: "ghost-agent" });
	assert.deepEqual(res.sessions, []);
	assert.equal(res.count, 0);
});
