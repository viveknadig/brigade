/**
 * Phase 6 — completion bridge fires a Discord thread farewell on child end.
 *
 * When a sub-agent that ran in a bound Discord thread ends, the completion
 * bridge posts a brief farewell into that thread (best-effort) and drops the
 * binding. A child with NO Discord binding triggers no Discord REST traffic.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	emitAgentEvent,
	resetAgentEventsForTests,
	wireAgentEventsBridge,
} from "./agent-events.js";
import {
	peekSystemEventEntries,
	resetSessionInboxForTest,
	resolveSystemEventDeliveryContext,
} from "./session-inbox.js";
import { registerSubagentRun, resetSubagentRegistryForTests } from "./subagent-registry.js";
import { resetSubagentCompletionBridgeForTests } from "./subagent-completion-bridge.js";
import type { BrigadeConfig } from "../config/io.js";
import {
	getDiscordSubagentThreadBinding,
	rememberDiscordSubagentThreadBinding,
	resetDiscordSubagentThreadBindingsForTests,
} from "./channels/discord/subagent-thread-binding.js";

const CFG = { channels: { discord: { botToken: "tok-test" } } } as unknown as BrigadeConfig;

test("completion bridge sends a Discord farewell + drops the binding on child end", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	resetDiscordSubagentThreadBindingsForTests();

	const savedToken = process.env.DISCORD_BOT_TOKEN;
	process.env.DISCORD_BOT_TOKEN = "tok-test";
	const originalFetch = globalThis.fetch;
	const fetchUrls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		fetchUrls.push(String(url));
		return { ok: true, status: 200, json: async () => ({ id: "msg-1" }) } as unknown as Response;
	}) as unknown as typeof fetch;

	const disposeBridge = wireAgentEventsBridge();
	try {
		const parentSessionKey = "agent:scout:main";
		const childSessionKey = "agent:scout:subagent:fw1:thread:t-1";
		const runId = "run-fw-1";

		// Seed a Discord thread binding for the child (as the materializer would).
		rememberDiscordSubagentThreadBinding({
			childSessionKey,
			threadId: "T-1",
			parentChannelId: "C-1",
			accountId: "default",
			agentId: "scout",
			label: "fw",
			boundAt: Date.now(),
		});

		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: parentSessionKey,
			requesterSessionKey: parentSessionKey,
			requesterDisplayKey: parentSessionKey,
			task: "thread task",
			cleanup: "keep",
			label: "fw",
			createdAt: Date.now() - 50,
		});

		emitAgentEvent({
			runId,
			stream: "lifecycle",
			sessionKey: childSessionKey,
			data: { phase: "end", ok: true, reply: "all done" },
		});

		// Let the per-parent chain + the lazy-imported farewell settle.
		await new Promise((r) => setTimeout(r, 50));
		void CFG;

		assert.ok(
			fetchUrls.some((u) => /\/channels\/T-1\/messages$/.test(u)),
			"a farewell was POSTed into the bound thread",
		);
		assert.equal(
			getDiscordSubagentThreadBinding(childSessionKey),
			undefined,
			"binding dropped after farewell",
		);
	} finally {
		disposeBridge();
		globalThis.fetch = originalFetch;
		if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
		else process.env.DISCORD_BOT_TOKEN = savedToken;
		resetDiscordSubagentThreadBindingsForTests();
		resetSubagentCompletionBridgeForTests();
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
	}
});

test("completion bridge delivers the child's reply INTO the bound thread (announce carries the thread deliveryContext)", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	resetDiscordSubagentThreadBindingsForTests();

	const savedToken = process.env.DISCORD_BOT_TOKEN;
	process.env.DISCORD_BOT_TOKEN = "tok-test";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		({ ok: true, status: 200, json: async () => ({ id: "msg-1" }) }) as unknown as Response) as unknown as typeof fetch;

	const disposeBridge = wireAgentEventsBridge();
	try {
		// A Discord-origin spawn: the parent session is a CHANNEL session (not the
		// operator main), so the announce routes through the inbox + channel.
		const parentSessionKey = "agent:scout:discord:peer:C-1";
		const childSessionKey = "agent:scout:subagent:rd1:thread:t-77";
		const runId = "run-rd-1";

		rememberDiscordSubagentThreadBinding({
			childSessionKey,
			threadId: "T-77",
			parentChannelId: "C-1",
			accountId: "default",
			agentId: "scout",
			boundAt: Date.now(),
		});

		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: parentSessionKey,
			requesterSessionKey: parentSessionKey,
			requesterDisplayKey: parentSessionKey,
			task: "thread task",
			cleanup: "keep",
			createdAt: Date.now() - 50,
		});

		emitAgentEvent({
			runId,
			stream: "lifecycle",
			sessionKey: childSessionKey,
			data: { phase: "end", ok: true, reply: "the child's final answer" },
		});

		await new Promise((r) => setTimeout(r, 60));

		// The announce landed in the PARENT inbox carrying the child's reply AND a
		// deliveryContext pointing at the BOUND THREAD — so the heartbeat hook's
		// deliverReplyToChannel will send the reply into the thread, not just the
		// parent's TUI inbox.
		const entries = peekSystemEventEntries(parentSessionKey);
		assert.equal(entries.length, 1, "one completion announce enqueued");
		assert.match(entries[0]!.text, /the child's final answer/, "announce carries the child's reply");
		const ctx = resolveSystemEventDeliveryContext(entries);
		assert.ok(ctx, "announce carries a delivery context");
		assert.equal(ctx!.channel, "discord", "delivery targets the discord channel");
		assert.equal(ctx!.to, "channel:T-77", "delivery targets the bound thread channel");
		assert.equal(String(ctx!.threadId), "T-77", "delivery context carries the thread id");
	} finally {
		disposeBridge();
		globalThis.fetch = originalFetch;
		if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
		else process.env.DISCORD_BOT_TOKEN = savedToken;
		resetDiscordSubagentThreadBindingsForTests();
		resetSubagentCompletionBridgeForTests();
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
		resetSessionInboxForTest();
	}
});

test("completion bridge makes no Discord REST call for an unbound child", async () => {
	resetAgentEventsForTests();
	resetSessionInboxForTest();
	resetSubagentRegistryForTests();
	resetSubagentCompletionBridgeForTests();
	resetDiscordSubagentThreadBindingsForTests();

	const originalFetch = globalThis.fetch;
	const fetchUrls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		fetchUrls.push(String(url));
		return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
	}) as unknown as typeof fetch;

	const disposeBridge = wireAgentEventsBridge();
	try {
		const childSessionKey = "agent:scout:subagent:nobind";
		const runId = "run-nobind";
		registerSubagentRun({
			runId,
			childSessionKey,
			controllerSessionKey: "agent:scout:main",
			requesterSessionKey: "agent:scout:main",
			requesterDisplayKey: "agent:scout:main",
			task: "no thread",
			cleanup: "keep",
			createdAt: Date.now() - 50,
		});
		emitAgentEvent({
			runId,
			stream: "lifecycle",
			sessionKey: childSessionKey,
			data: { phase: "end", ok: true, reply: "x" },
		});
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(
			fetchUrls.some((u) => /discord\.com/.test(u)),
			false,
			"no Discord REST traffic for an unbound child",
		);
	} finally {
		disposeBridge();
		globalThis.fetch = originalFetch;
		resetDiscordSubagentThreadBindingsForTests();
		resetSubagentCompletionBridgeForTests();
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
	}
});
