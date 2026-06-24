/**
 * Phase 6 — Discord sub-agent thread-binding (materializer) unit tests.
 *
 * Exercises the Brigade-native materializer in isolation with an injected
 * config + injected `fetch` (no network, no live adapter): thread creation +
 * intro starter message, child-session re-rooting into `:thread:<id>`, the
 * session-metadata binding registry, the farewell-on-end, and the startup
 * reconcile.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import {
	buildSubagentThreadFarewell,
	buildSubagentThreadIntro,
	getDiscordSubagentThreadBinding,
	listDiscordSubagentThreadBindings,
	materializeDiscordSubagentThread,
	reconcileDiscordSubagentThreadBindings,
	resetDiscordSubagentThreadBindingsForTests,
	sendDiscordSubagentThreadFarewell,
} from "./subagent-thread-binding.js";

const CFG = { channels: { discord: { botToken: "tok-test" } } } as unknown as BrigadeConfig;

type RecordedCall = { url: string; method: string; body: unknown };

function makeFetchStub(opts: { threadId?: string } = {}): {
	fetchImpl: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (url: unknown, init: unknown) => {
		const u = String(url);
		const i = (init ?? {}) as { method?: string; body?: string };
		calls.push({
			url: u,
			method: i.method ?? "GET",
			body: i.body ? JSON.parse(i.body) : undefined,
		});
		// Thread-create returns the new thread channel object.
		const json = u.includes("/threads")
			? { id: opts.threadId ?? "thread-999" }
			: { id: "msg-1" };
		return {
			ok: true,
			status: 200,
			json: async () => json,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("discord subagent thread-binding (Phase 6 materializer)", () => {
	beforeEach(() => resetDiscordSubagentThreadBindingsForTests());
	afterEach(() => resetDiscordSubagentThreadBindingsForTests());

	it("builds an intro that names the agent + summarizes the task", () => {
		const intro = buildSubagentThreadIntro({ agentId: "scout", task: "find the bug", label: "hunt" });
		assert.match(intro, /scout/);
		assert.match(intro, /hunt/);
		assert.match(intro, /find the bug/);
		assert.match(intro, /🧵/);
	});

	it("builds outcome-specific farewells", () => {
		assert.match(buildSubagentThreadFarewell({ agentId: "scout" }), /✓/);
		assert.match(buildSubagentThreadFarewell({ agentId: "scout", outcome: "error" }), /error/i);
		assert.match(buildSubagentThreadFarewell({ agentId: "scout", outcome: "timeout" }), /timed out/i);
		assert.match(buildSubagentThreadFarewell({ agentId: "scout", outcome: "abort" }), /stopped/i);
	});

	it("creates a thread, posts the intro as starter, and re-roots the child session", async () => {
		const { fetchImpl, calls } = makeFetchStub({ threadId: "T-42" });
		const result = await materializeDiscordSubagentThread({
			parentChannelId: "C-100",
			accountId: "default",
			baseChildSessionKey: "agent:scout:subagent:abc",
			agentId: "scout",
			task: "summarize the repo",
			label: "summary",
			cfg: CFG,
			fetchImpl,
		});

		assert.ok(result, "materialize returned a result");
		assert.equal(result!.threadId, "T-42");
		// The child session key is re-rooted into the thread.
		assert.equal(result!.childSessionKey, "agent:scout:subagent:abc:thread:t-42");

		// Exactly one REST call: POST /channels/C-100/threads with starter content.
		const threadCalls = calls.filter((c) => /\/channels\/C-100\/threads$/.test(c.url));
		assert.equal(threadCalls.length, 1, "one thread-create call");
		assert.equal(threadCalls[0]!.method, "POST");
		const body = threadCalls[0]!.body as { name?: string; message?: { content?: string } };
		assert.ok(body.name && body.name.length <= 100, "thread name set + within 100 chars");
		assert.match(body.message?.content ?? "", /summarize the repo/, "intro is the starter message");

		// The binding is stored as session metadata keyed by the child key.
		const binding = getDiscordSubagentThreadBinding(result!.childSessionKey);
		assert.ok(binding, "binding stored");
		assert.equal(binding!.threadId, "T-42");
		assert.equal(binding!.parentChannelId, "C-100");
		assert.equal(binding!.agentId, "scout");
	});

	it("returns null (no binding) when no bot token is resolvable", async () => {
		const { fetchImpl } = makeFetchStub();
		const result = await materializeDiscordSubagentThread({
			parentChannelId: "C-100",
			baseChildSessionKey: "agent:scout:subagent:abc",
			agentId: "scout",
			task: "x",
			cfg: { channels: { discord: {} } } as unknown as BrigadeConfig,
			fetchImpl,
		});
		assert.equal(result, null, "no token → no thread");
		assert.equal(listDiscordSubagentThreadBindings().length, 0, "no binding stored");
	});

	it("returns null when thread creation throws (spawn falls back un-threaded)", async () => {
		const fetchImpl = (async () => {
			throw new Error("discord 403");
		}) as unknown as typeof fetch;
		const result = await materializeDiscordSubagentThread({
			parentChannelId: "C-100",
			baseChildSessionKey: "agent:scout:subagent:abc",
			agentId: "scout",
			task: "x",
			cfg: CFG,
			fetchImpl,
		});
		assert.equal(result, null);
		assert.equal(listDiscordSubagentThreadBindings().length, 0);
	});

	it("sends a farewell into the bound thread on end and drops the binding", async () => {
		const { fetchImpl, calls } = makeFetchStub({ threadId: "T-7" });
		const result = await materializeDiscordSubagentThread({
			parentChannelId: "C-1",
			baseChildSessionKey: "agent:scout:subagent:zzz",
			agentId: "scout",
			task: "do the thing",
			cfg: CFG,
			fetchImpl,
		});
		assert.ok(result);
		calls.length = 0;

		const sent = await sendDiscordSubagentThreadFarewell({
			childSessionKey: result!.childSessionKey,
			outcome: "ok",
			cfg: CFG,
			fetchImpl,
		});
		assert.equal(sent, true, "farewell sent");

		// The farewell is a POST into the thread channel.
		const sendCalls = calls.filter((c) => /\/channels\/T-7\/messages$/.test(c.url));
		assert.equal(sendCalls.length, 1, "one farewell send into the thread");
		assert.match((sendCalls[0]!.body as { content?: string }).content ?? "", /✓/);

		// Binding dropped after the farewell.
		assert.equal(
			getDiscordSubagentThreadBinding(result!.childSessionKey),
			undefined,
			"binding forgotten after farewell",
		);
	});

	it("farewell is a no-op when no binding exists", async () => {
		const { fetchImpl, calls } = makeFetchStub();
		const sent = await sendDiscordSubagentThreadFarewell({
			childSessionKey: "agent:scout:subagent:none:thread:x",
			cfg: CFG,
			fetchImpl,
		});
		assert.equal(sent, false);
		assert.equal(calls.length, 0, "no REST call for an unknown child");
	});

	it("reconcile drops bindings whose child session is no longer live", async () => {
		const { fetchImpl } = makeFetchStub({ threadId: "T-1" });
		const a = await materializeDiscordSubagentThread({
			parentChannelId: "C-1",
			baseChildSessionKey: "agent:scout:subagent:live",
			agentId: "scout",
			task: "a",
			cfg: CFG,
			fetchImpl,
		});
		const { fetchImpl: f2 } = makeFetchStub({ threadId: "T-2" });
		const b = await materializeDiscordSubagentThread({
			parentChannelId: "C-1",
			baseChildSessionKey: "agent:scout:subagent:dead",
			agentId: "scout",
			task: "b",
			cfg: CFG,
			fetchImpl: f2,
		});
		assert.ok(a && b);
		assert.equal(listDiscordSubagentThreadBindings().length, 2);

		const dropped = reconcileDiscordSubagentThreadBindings(
			(key) => key === a!.childSessionKey,
		);
		assert.equal(dropped, 1, "one stale binding dropped");
		assert.ok(getDiscordSubagentThreadBinding(a!.childSessionKey), "live binding kept");
		assert.equal(getDiscordSubagentThreadBinding(b!.childSessionKey), undefined, "dead binding dropped");
	});
});
