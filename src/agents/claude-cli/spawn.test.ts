import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
	CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS,
	CLAUDE_CLI_OVERALL_TIMEOUT_MS,
	CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS,
	CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS,
	spawnClaudeCli,
} from "./spawn.js";

// The exec-gate awaits an operator approval for up to 5 minutes. A tool-plane
// spawn goes SILENT for that whole wait (it is blocked on Brigade's /mcp
// response), so the no-output watchdog must outlast it — otherwise Brigade
// SIGKILLs its own child before the operator can approve.
const EXEC_GATE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

test("tool-plane no-output watchdog outlasts the exec-gate approval window", () => {
	assert.ok(
		CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS > EXEC_GATE_APPROVAL_TIMEOUT_MS,
		`watchdog ${CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS}ms must exceed approval ${EXEC_GATE_APPROVAL_TIMEOUT_MS}ms`,
	);
	// ...and the plain chat watchdog must NOT be widened (a silent chat turn is wedged).
	assert.ok(CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS < EXEC_GATE_APPROVAL_TIMEOUT_MS);
});

test("tool-plane hard ceiling exceeds the no-output grace and the chat ceiling", () => {
	assert.ok(CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS > CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS);
	assert.ok(CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS > CLAUDE_CLI_OVERALL_TIMEOUT_MS);
});

/* ─────────── pausing the watchdogs while Brigade runs the child's tool ─────────── */

/** A child that never speaks — exactly what a binary blocked on our /mcp does. */
function silentChild() {
	const killed: string[] = [];
	const child = new EventEmitter() as any;
	child.stdout = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr = new EventEmitter();
	child.stderr.setEncoding = () => {};
	child.stdin = { write: () => {}, end: () => {} };
	child.kill = (sig?: string) => killed.push(sig ?? "SIGTERM");
	return { child, killed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a silent child IS killed once its no-output grace elapses (watchdog still works)", async () => {
	const { child, killed } = silentChild();
	const handle = spawnClaudeCli({
		args: [],
		stdin: "hi",
		noOutputTimeoutMs: 20,
		overallTimeoutMs: 10_000,
		spawnFn: (() => child) as never,
	});
	await sleep(60);
	assert.deepEqual(killed, ["SIGKILL"], "a genuinely wedged child is still reaped");
	child.emit("close", 137);
	await handle.done;
});

test("PAUSED: a child blocked on a Brigade tool is NOT killed, however long the tool runs", async () => {
	const { child, killed } = silentChild();
	const handle = spawnClaudeCli({
		args: [],
		stdin: "hi",
		noOutputTimeoutMs: 20, // would fire almost immediately…
		overallTimeoutMs: 30, // …and so would the hard ceiling
		spawnFn: (() => child) as never,
	});

	// Brigade starts executing spawn_agent / generate_video on the child's behalf.
	const resume = handle.pause();
	await sleep(120); // far longer than BOTH watchdogs
	assert.deepEqual(killed, [], "the child is waiting on us, not wedged");

	resume(); // the tool finished; liveness resumes
	await sleep(60);
	assert.deepEqual(killed, ["SIGKILL"], "…and a child that then goes silent is still reaped");
	child.emit("close", 137);
	await handle.done;
});

test("nested pauses are counted — the inner tool finishing must not rearm the watchdog", async () => {
	const { child, killed } = silentChild();
	const handle = spawnClaudeCli({
		args: [],
		stdin: "hi",
		noOutputTimeoutMs: 20,
		overallTimeoutMs: 10_000,
		spawnFn: (() => child) as never,
	});

	const outer = handle.pause(); // e.g. spawn_agent
	const inner = handle.pause(); // a tool the child of that sub-agent called
	inner();
	await sleep(60);
	assert.deepEqual(killed, [], "outer tool is still running");

	outer();
	await sleep(60);
	assert.deepEqual(killed, ["SIGKILL"]);
	child.emit("close", 137);
	await handle.done;
});

test("resume is idempotent and safe after the child exits", async () => {
	const { child } = silentChild();
	const handle = spawnClaudeCli({
		args: [],
		stdin: "hi",
		noOutputTimeoutMs: 10_000,
		overallTimeoutMs: 10_000,
		spawnFn: (() => child) as never,
	});
	const resume = handle.pause();
	child.emit("close", 0);
	await handle.done;
	assert.doesNotThrow(() => resume());
	assert.doesNotThrow(() => resume());
	assert.doesNotThrow(() => handle.pause()());
});
