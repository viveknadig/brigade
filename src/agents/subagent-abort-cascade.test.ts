/**
 * Wave O0.7 - parent abort cascade test.
 *
 * Asserts that when a parent session terminates, every active child it
 * spawned is aborted in turn. The cascade fires off the
 * `onSessionStateChange` listener installed by `agent-events.ts:
 * wireAgentEventsBridge`, so we wire the bridge here too.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resetAgentEventsForTests, wireAgentEventsBridge } from "./agent-events.js";
import {
	abortLiveSession,
	getLiveSession,
	registerLiveSession,
	resetSessionRegistryForTests,
} from "./session-registry.js";
import {
	registerSubagentRun,
	resetSubagentRegistryForTests,
} from "./subagent-registry.js";

test("parent abort cascades to active children", async () => {
	resetAgentEventsForTests();
	resetSessionRegistryForTests();
	resetSubagentRegistryForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:main";
	const child1 = "agent:default:subagent:abort-c1";
	const child2 = "agent:default:subagent:abort-c2";

	// Register the parent live-session + both children + their subagent
	// runs so the cascade can find them via
	// listActiveSubagentRunsForController.
	const parentAbort = new AbortController();
	registerLiveSession({
		sessionKey: parentSessionKey,
		sessionId: "parent-sid",
		agentId: "default",
		runId: "parent-run",
		lane: "main",
		abortController: parentAbort,
	});

	const child1Abort = new AbortController();
	registerLiveSession({
		sessionKey: child1,
		sessionId: "child1-sid",
		agentId: "default",
		runId: "child1-run",
		lane: "sub-1",
		abortController: child1Abort,
	});

	const child2Abort = new AbortController();
	registerLiveSession({
		sessionKey: child2,
		sessionId: "child2-sid",
		agentId: "default",
		runId: "child2-run",
		lane: "sub-2",
		abortController: child2Abort,
	});

	registerSubagentRun({
		runId: "child1-run",
		childSessionKey: child1,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "t1",
		cleanup: "keep",
		createdAt: Date.now(),
	});
	registerSubagentRun({
		runId: "child2-run",
		childSessionKey: child2,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "t2",
		cleanup: "keep",
		createdAt: Date.now(),
	});

	// Sanity: both children are live before the abort
	assert.equal(getLiveSession(child1)?.state, "running");
	assert.equal(getLiveSession(child2)?.state, "running");
	assert.equal(child1Abort.signal.aborted, false);
	assert.equal(child2Abort.signal.aborted, false);

	// Trigger the parent abort. The cascade listens for the parent's
	// state-change event and fires `abortLiveSession` on every active
	// child within the same tick.
	abortLiveSession(parentSessionKey, "operator-ctrl-c");

	// Listener runs synchronously off the registry's `emit`, but the
	// cascade's child abort still goes through `abortLiveSession` which
	// emits its own state change. One microtask is plenty.
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(child1Abort.signal.aborted, true, "child 1 should be aborted");
	assert.equal(child2Abort.signal.aborted, true, "child 2 should be aborted");
	assert.equal(getLiveSession(child1)?.state, "terminated");
	assert.equal(getLiveSession(child2)?.state, "terminated");

	disposeBridge();
	resetSubagentRegistryForTests();
	resetSessionRegistryForTests();
	resetAgentEventsForTests();
});

test("parent abort with no live children is a no-op", async () => {
	resetAgentEventsForTests();
	resetSessionRegistryForTests();
	resetSubagentRegistryForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:main";
	const parentAbort = new AbortController();
	registerLiveSession({
		sessionKey: parentSessionKey,
		sessionId: "parent-sid",
		agentId: "default",
		runId: "parent-run",
		lane: "main",
		abortController: parentAbort,
	});

	// No children registered - the cascade should run without throwing.
	abortLiveSession(parentSessionKey, "shutdown");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(parentAbort.signal.aborted, true);

	disposeBridge();
	resetSubagentRegistryForTests();
	resetSessionRegistryForTests();
	resetAgentEventsForTests();
});
