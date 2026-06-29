/**
 * Wave O0.7 VERIFY GATE - end-to-end spawn lifecycle test.
 *
 * Asserts the full "parent spawns child via sessions_spawn -> child
 * completes with a known reply -> parent's next turn sees the completion
 * announce carrying the child's reply" flow.
 *
 * The test wires the completion bridge against the agent-events bus and
 * synthesises a `lifecycle:phase:end` event with `reply: <text>` for a
 * registered sub-agent run. It then asserts the parent's session inbox
 * contains an announce with the same text body, the correct child
 * session key, and a "completed" status.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { emitAgentEvent, resetAgentEventsForTests, wireAgentEventsBridge } from "./agent-events.js";
import { drainSystemEvents, resetSessionInboxForTest } from "./session-inbox.js";
import {
	registerSubagentRun,
	resetSubagentRegistryForTests,
} from "./subagent-registry.js";

test("spawn lifecycle: parent next turn sees child completion announce", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:main";
	const childSessionKey = "agent:default:subagent:e2e-1";
	const runId = "run-e2e-lifecycle-1";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "do something",
		cleanup: "keep",
		label: "e2e",
		createdAt: Date.now() - 1500,
	});

	// Synthesise the lifecycle "end" event that runAgentTurn-via-dispatcher
	// would emit when the child's turn completes. The `reply` field is
	// the channel the dispatcher uses to thread the child's final
	// assistant text through to the completion bridge.
	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: true,
			reply: "Final answer from child: 42",
		},
	});

	// Bridge's listener does async work (markSubagentRunCompleted is
	// async). Wait a tick so the announce lands.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 5));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 1, `expected 1 announce event, got ${events.length}`);
	const text = events[0]!;
	assert.match(text, /Sub-agent "e2e" completed/);
	assert.ok(text.includes(`childSessionKey=${childSessionKey}`), `expected childSessionKey=${childSessionKey} in: ${text}`);
	assert.match(text, /status=completed/);
	assert.match(text, /Final answer from child: 42/);

	disposeBridge();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});

test("spawn lifecycle: failure path delivers error + last reply", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	const disposeBridge = wireAgentEventsBridge();

	const parentSessionKey = "agent:default:main";
	const childSessionKey = "agent:default:subagent:e2e-2";
	const runId = "run-e2e-lifecycle-2";

	registerSubagentRun({
		runId,
		childSessionKey,
		controllerSessionKey: parentSessionKey,
		requesterSessionKey: parentSessionKey,
		requesterDisplayKey: parentSessionKey,
		task: "do something",
		cleanup: "keep",
		label: "broken",
		createdAt: Date.now() - 800,
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: childSessionKey,
		data: {
			phase: "end",
			ok: false,
			error: "provider 500",
			reply: "got partway then errored",
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 5));

	const events = drainSystemEvents(parentSessionKey);
	assert.equal(events.length, 1);
	const text = events[0]!;
	assert.match(text, /Sub-agent "broken" failed/);
	assert.match(text, /status=failed/);
	assert.match(text, /Error: provider 500/);
	assert.match(text, /Last reply before failure:\ngot partway then errored/);

	disposeBridge();
	resetSubagentRegistryForTests();
	resetSessionInboxForTest();
	resetAgentEventsForTests();
});
