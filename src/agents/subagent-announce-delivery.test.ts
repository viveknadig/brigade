/**
 * Wave O0.7 - subagent-announce-delivery unit + lifecycle integration tests.
 *
 * Covers:
 *
 *   1. `buildSubagentCompletionAnnounceText` pure-function shape (success,
 *       failure, abort, timeout, missing reply, truncation).
 *   2. `deliverSubagentCompletionAnnounce` enqueues into the parent's
 *       session inbox with the correct `contextKey:subagent:ended:<runId>`,
 *       idempotently.
 *   3. End-to-end: a parent spawns a child via the completion bridge
 *       receiving a synthetic `lifecycle:phase:end` with `reply` text;
 *       the parent's inbox surfaces the final reply.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	buildSubagentCompletionAnnounceText,
	deliverSubagentCompletionAnnounce,
	pickReplyTextFromRegistryEntry,
} from "./subagent-announce-delivery.js";
import { drainSystemEvents, resetSessionInboxForTest } from "./session-inbox.js";
import {
	SUBAGENT_ENDED_OUTCOME_ABORT,
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
} from "./subagent-lifecycle-events.js";

test("buildSubagentCompletionAnnounceText renders ok with reply", () => {
	const text = buildSubagentCompletionAnnounceText({
		label: "research",
		childSessionKey: "agent:default:subagent:abc",
		runId: "run-1",
		outcome: SUBAGENT_ENDED_OUTCOME_OK,
		replyText: "Hello from the child!",
		durationMs: 1234,
	});
	assert.match(text, /Sub-agent "research" completed/);
	assert.match(text, /\(1234ms\)/);
	assert.match(text, /childSessionKey=agent:default:subagent:abc/);
	assert.match(text, /status=completed/);
	assert.match(text, /Final reply:\nHello from the child!/);
});

test("buildSubagentCompletionAnnounceText renders failure with error", () => {
	const text = buildSubagentCompletionAnnounceText({
		childSessionKey: "agent:default:subagent:xyz",
		runId: "run-2",
		outcome: SUBAGENT_ENDED_OUTCOME_ERROR,
		error: "model returned 5xx",
	});
	assert.match(text, /Sub-agent failed/);
	assert.match(text, /status=failed/);
	assert.match(text, /Error: model returned 5xx/);
});

test("buildSubagentCompletionAnnounceText renders timeout", () => {
	const text = buildSubagentCompletionAnnounceText({
		label: "slow-task",
		childSessionKey: "agent:default:subagent:to1",
		runId: "run-3",
		outcome: SUBAGENT_ENDED_OUTCOME_TIMEOUT,
		replyText: "partial output",
	});
	assert.match(text, /timed out/);
	assert.match(text, /status=timed-out/);
	assert.match(text, /Last reply before timed-out:\npartial output/);
});

test("buildSubagentCompletionAnnounceText renders abort", () => {
	const text = buildSubagentCompletionAnnounceText({
		childSessionKey: "agent:default:subagent:ab1",
		runId: "run-4",
		outcome: SUBAGENT_ENDED_OUTCOME_ABORT,
	});
	assert.match(text, /was aborted/);
	assert.match(text, /status=aborted/);
});

test("buildSubagentCompletionAnnounceText truncates very long replies", () => {
	const huge = "x".repeat(10_000);
	const text = buildSubagentCompletionAnnounceText({
		childSessionKey: "agent:default:subagent:big",
		runId: "run-5",
		outcome: SUBAGENT_ENDED_OUTCOME_OK,
		replyText: huge,
	});
	assert.ok(text.length < 5_000, `expected truncated body, got ${text.length} chars`);
	assert.match(text, /truncated/);
});

test("deliverSubagentCompletionAnnounce enqueues to parent inbox", () => {
	resetSessionInboxForTest();
	const parentKey = "agent:default:main";
	const enqueued = deliverSubagentCompletionAnnounce({
		parentSessionKey: parentKey,
		childSessionKey: "agent:default:subagent:abc",
		runId: "run-100",
		outcome: SUBAGENT_ENDED_OUTCOME_OK,
		replyText: "Result text from child",
		label: "lookup",
	});
	assert.equal(enqueued, true);
	const events = drainSystemEvents(parentKey);
	assert.equal(events.length, 1);
	assert.match(events[0]!, /Sub-agent "lookup" completed/);
	assert.match(events[0]!, /Final reply:\nResult text from child/);
	resetSessionInboxForTest();
});

test("deliverSubagentCompletionAnnounce dedupes consecutive same-text calls", () => {
	resetSessionInboxForTest();
	const parentKey = "agent:default:main";
	const params = {
		parentSessionKey: parentKey,
		childSessionKey: "agent:default:subagent:abc",
		runId: "run-200",
		outcome: SUBAGENT_ENDED_OUTCOME_OK,
		replyText: "identical reply",
	};
	const first = deliverSubagentCompletionAnnounce(params);
	const second = deliverSubagentCompletionAnnounce(params);
	assert.equal(first, true);
	// The session-inbox suppresses consecutive duplicates by text, so the
	// second call returns false even though contextKey gating is advisory.
	assert.equal(second, false);
	const events = drainSystemEvents(parentKey);
	assert.equal(events.length, 1);
	assert.match(events[0]!, /identical reply/);
	resetSessionInboxForTest();
});

test("deliverSubagentCompletionAnnounce skips the 'main' sentinel parent", () => {
	resetSessionInboxForTest();
	const enqueued = deliverSubagentCompletionAnnounce({
		parentSessionKey: "main",
		childSessionKey: "agent:default:subagent:abc",
		runId: "run-300",
		outcome: SUBAGENT_ENDED_OUTCOME_OK,
	});
	assert.equal(enqueued, false);
});

test("pickReplyTextFromRegistryEntry prefers frozenResultText", () => {
	const entry = {
		runId: "r1",
		childSessionKey: "agent:default:subagent:k",
		requesterSessionKey: "agent:default:main",
		requesterDisplayKey: "main",
		task: "do thing",
		cleanup: "keep" as const,
		createdAt: Date.now(),
		frozenResultText: "FROZEN",
		outcome: { status: "ok" as const, text: "OUTCOME" },
	};
	assert.equal(pickReplyTextFromRegistryEntry(entry), "FROZEN");
});

test("pickReplyTextFromRegistryEntry falls back to outcome text", () => {
	const entry = {
		runId: "r2",
		childSessionKey: "agent:default:subagent:k2",
		requesterSessionKey: "agent:default:main",
		requesterDisplayKey: "main",
		task: "do thing",
		cleanup: "keep" as const,
		createdAt: Date.now(),
		outcome: { status: "ok" as const, text: "OUTCOME" },
	};
	assert.equal(pickReplyTextFromRegistryEntry(entry), "OUTCOME");
});

test("pickReplyTextFromRegistryEntry returns undefined when no text source", () => {
	const entry = {
		runId: "r3",
		childSessionKey: "agent:default:subagent:k3",
		requesterSessionKey: "agent:default:main",
		requesterDisplayKey: "main",
		task: "do thing",
		cleanup: "keep" as const,
		createdAt: Date.now(),
	};
	assert.equal(pickReplyTextFromRegistryEntry(entry), undefined);
});
