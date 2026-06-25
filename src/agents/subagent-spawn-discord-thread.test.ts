/**
 * Phase 6 — sub-agent spawn engine × Discord thread-binding gating.
 *
 * Verifies that `spawnSubagentDirect` materializes a Discord thread ONLY for a
 * `thread: true` spawn whose origin is a Discord conversation, and that every
 * other spawn (non-thread, or non-Discord origin) is byte-identical to before
 * (no thread, no intro, no binding, base child key, parent-channel delivery).
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	resetGatewayCallerForTests,
	setGlobalGatewayCaller,
	type GatewayCallOptions,
	type GatewayCaller,
} from "./gateway-call.js";
import { resetAgentEventsForTests } from "./agent-events.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import {
	listDiscordSubagentThreadBindings,
	resetDiscordSubagentThreadBindingsForTests,
} from "./channels/discord/subagent-thread-binding.js";

const PARENT_KEY = "agent:scout:main";

function makeStubCaller(): { caller: GatewayCaller; agentCalls: GatewayCallOptions[] } {
	const agentCalls: GatewayCallOptions[] = [];
	const caller: GatewayCaller = {
		call: async <T = Record<string, unknown>>(opts: GatewayCallOptions): Promise<T> => {
			if (opts.method === "agent") agentCalls.push(opts);
			return { ok: true } as T;
		},
	};
	return { caller, agentCalls };
}

/** Stub `globalThis.fetch` so the materializer's REST calls never hit the network. */
function installFetchStub(threadId: string): { calls: string[]; restore: () => void } {
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		const u = String(url);
		calls.push(u);
		const i = (init ?? {}) as { method?: string };
		void i;
		const json = u.includes("/threads") ? { id: threadId } : { id: "msg-1" };
		return { ok: true, status: 200, json: async () => json } as unknown as Response;
	}) as unknown as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("subagent-spawn × discord thread-binding gating (Phase 6)", () => {
	let savedToken: string | undefined;

	beforeEach(() => {
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
		resetGatewayCallerForTests();
		resetDiscordSubagentThreadBindingsForTests();
		savedToken = process.env.DISCORD_BOT_TOKEN;
		process.env.DISCORD_BOT_TOKEN = "tok-engine-test";
	});

	afterEach(() => {
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
		resetGatewayCallerForTests();
		resetDiscordSubagentThreadBindingsForTests();
		if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
		else process.env.DISCORD_BOT_TOKEN = savedToken;
	});

	it("materializes a thread + binds the child for a Discord-origin thread:true spawn", async () => {
		const { caller, agentCalls } = makeStubCaller();
		setGlobalGatewayCaller(caller);
		const fetchStub = installFetchStub("T-555");
		try {
			const result = await spawnSubagentDirect(
				{ task: "investigate the flake", label: "flake", thread: true },
				{
					agentSessionKey: PARENT_KEY,
					agentChannel: "discord",
					agentTo: "C-200",
					agentAccountId: "default",
					callerDepth: 0,
				},
			);

			assert.equal(result.status, "accepted");
			// Child key was re-rooted into the thread.
			assert.match(result.childSessionKey ?? "", /:thread:t-555$/);

			// A thread-create REST call happened (intro starter).
			assert.ok(
				fetchStub.calls.some((u) => /\/channels\/C-200\/threads$/.test(u)),
				"thread-create REST call fired",
			);

			// A binding was stored as session metadata.
			const bindings = listDiscordSubagentThreadBindings();
			assert.equal(bindings.length, 1, "one thread binding stored");
			assert.equal(bindings[0]!.threadId, "T-555");

			// The child was dispatched INTO the thread (threadId + to point at it).
			assert.equal(agentCalls.length, 1, "one agent dispatch");
			const p = agentCalls[0]!.params as { threadId?: unknown; to?: unknown; sessionKey?: string };
			assert.equal(p.threadId, "T-555", "dispatch threadId is the bound thread");
			assert.equal(p.to, "channel:T-555", "dispatch targets the thread channel");
			assert.match(String(p.sessionKey), /:thread:t-555$/, "dispatch uses the thread session key");
		} finally {
			fetchStub.restore();
		}
	});

	it("does NOT materialize a thread for a thread:false Discord spawn (byte-identical)", async () => {
		const { caller, agentCalls } = makeStubCaller();
		setGlobalGatewayCaller(caller);
		const fetchStub = installFetchStub("T-NONE");
		try {
			const result = await spawnSubagentDirect(
				{ task: "no thread here", thread: false },
				{ agentSessionKey: PARENT_KEY, agentChannel: "discord", agentTo: "C-200", callerDepth: 0 },
			);
			assert.equal(result.status, "accepted");
			assert.doesNotMatch(result.childSessionKey ?? "", /:thread:/, "base child key (no thread suffix)");
			assert.equal(listDiscordSubagentThreadBindings().length, 0, "no binding");
			assert.equal(fetchStub.calls.length, 0, "no Discord REST call");
			const p = agentCalls[0]!.params as { threadId?: unknown };
			assert.equal(p.threadId, undefined, "no threadId on dispatch");
		} finally {
			fetchStub.restore();
		}
	});

	it("does NOT materialize a thread for a non-Discord origin thread:true spawn", async () => {
		const { caller, agentCalls } = makeStubCaller();
		setGlobalGatewayCaller(caller);
		const fetchStub = installFetchStub("T-NONE");
		try {
			const result = await spawnSubagentDirect(
				{ task: "thread on slack", thread: true },
				{ agentSessionKey: PARENT_KEY, agentChannel: "slack", agentTo: "C-9", callerDepth: 0 },
			);
			assert.equal(result.status, "accepted");
			assert.doesNotMatch(result.childSessionKey ?? "", /:thread:/, "no Discord thread re-root");
			assert.equal(listDiscordSubagentThreadBindings().length, 0, "no Discord binding");
			assert.equal(fetchStub.calls.length, 0, "no Discord REST call for a slack origin");
			void agentCalls;
		} finally {
			fetchStub.restore();
		}
	});
});
