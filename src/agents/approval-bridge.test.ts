/**
 * Tests for the approval bridge — pure unit-level coverage of the
 * in-memory request/resolve/timeout behaviour.
 *
 * Persistence behaviour (`applyApprovalDecision` calling `recordApproval`)
 * is tested in exec-approvals.test.ts; here we mock the broadcaster and
 * verify the bridge's own state machine.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	type ApprovalDecisionKind,
	type ApprovalRequest,
	getActiveApprovalBridge,
	InMemoryApprovalBridge,
	setActiveApprovalBridge,
} from "./approval-bridge.js";

const DECISIONS: ReadonlyArray<ApprovalDecisionKind> = [
	"allow-once",
	"allow-always",
	"allow-pattern",
	"deny",
];

describe("InMemoryApprovalBridge", () => {
	afterEach(() => {
		setActiveApprovalBridge(null);
	});

	it("broadcasts a request and resolves the returned promise", async () => {
		const broadcasts: ApprovalRequest[] = [];
		const bridge = new InMemoryApprovalBridge((req) => broadcasts.push(req));
		const pending = bridge.requestApproval({
			command: "ls -la",
			toolName: "bash",
			cwd: "/tmp",
			timeoutMs: 10_000,
			decisions: DECISIONS,
		});
		assert.equal(broadcasts.length, 1);
		const broadcastId = broadcasts[0]!.id;
		const resolved = bridge.resolveApproval(broadcastId, { kind: "allow-once" });
		assert.equal(resolved, true);
		const decision = await pending;
		assert.equal(decision.kind, "allow-once");
		assert.equal(decision.timedOut, undefined);
	});

	it("times out with kind:'deny' + timedOut:true when the operator never replies", async () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const pending = bridge.requestApproval({
			command: "git status",
			toolName: "bash",
			timeoutMs: 30,
			decisions: DECISIONS,
		});
		const decision = await pending;
		assert.equal(decision.kind, "deny");
		assert.equal(decision.timedOut, true);
	});

	it("resolveApproval returns false for unknown id (stale / double-click)", () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const handled = bridge.resolveApproval("does-not-exist", { kind: "allow-once" });
		assert.equal(handled, false);
	});

	it("listPending shows only un-resolved requests", () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		void bridge.requestApproval({
			command: "echo a",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		void bridge.requestApproval({
			command: "echo b",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		const pending = bridge.listPending();
		assert.equal(pending.length, 2);
		// Drain so the dangling timers don't keep the test runner alive
		// beyond afterEach (the timer's unref guards against this anyway,
		// but explicit resolve is cleaner).
		for (const req of pending) bridge.resolveApproval(req.id, { kind: "deny" });
	});

	it("survives a broadcast that throws (e.g. no clients connected)", async () => {
		const bridge = new InMemoryApprovalBridge(() => {
			throw new Error("no clients");
		});
		const pending = bridge.requestApproval({
			command: "ls",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		const ids = bridge.listPending().map((r) => r.id);
		assert.equal(ids.length, 1);
		// Caller can still resolve manually (e.g. via a late-arriving client).
		assert.equal(bridge.resolveApproval(ids[0]!, { kind: "allow-once" }), true);
		const decision = await pending;
		assert.equal(decision.kind, "allow-once");
	});

	it("setActiveApprovalBridge / getActiveApprovalBridge round-trip", () => {
		assert.equal(getActiveApprovalBridge(), null);
		const bridge = new InMemoryApprovalBridge(() => {});
		setActiveApprovalBridge(bridge);
		assert.equal(getActiveApprovalBridge(), bridge);
		setActiveApprovalBridge(null);
		assert.equal(getActiveApprovalBridge(), null);
	});
});
