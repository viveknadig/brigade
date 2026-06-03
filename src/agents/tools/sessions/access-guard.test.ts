/**
 * Session-tool access guard tests (Wave O0 — CRITICAL).
 *
 * Each of the four sessions tools (`sessions_send`, `sessions_history`,
 * `sessions_list`, `sessions_spawn`) must call `checkSessionToolAccess`
 * BEFORE dispatching when wired with a visibility + A2A policy. Pre-O0
 * the helpers existed but no caller invoked them.
 *
 * The tests instantiate each tool with a `self` visibility + disabled A2A
 * policy and assert that:
 *   - cross-agent targets are refused with a `status: forbidden` envelope,
 *   - same-agent (own session) targets pass through.
 *
 * Tests never touch the wire — the tool's `execute(...)` body returns the
 * forbidden envelope locally before any `callGateway` dispatch lands.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createAgentToAgentPolicy,
	type SessionToolsVisibility,
} from "./shared.js";
import { createSessionsHistoryTool } from "./history.js";
import { createSessionsListTool } from "./list.js";
import { createSessionsSendTool } from "./send.js";
import { createSessionsSpawnTool } from "./spawn.js";
import { setGlobalGatewayCaller, resetGatewayCallerForTests } from "../../gateway-call.js";

const CALLER_KEY = "agent:alice:main";
const TARGET_OTHER_AGENT_KEY = "agent:bob:main";
const TARGET_SAME_AGENT_KEY = "agent:alice:subagent:zzz";

const SELF_VISIBILITY: SessionToolsVisibility = "self";
const ALL_VISIBILITY: SessionToolsVisibility = "all";

const POLICY_DISABLED = createAgentToAgentPolicy({ enabled: false, allow: [] });
const POLICY_ENABLED_ALL = createAgentToAgentPolicy({ enabled: true, allow: ["*"] });

function parseEnvelope(text: string): { status?: string; error?: string } {
	try {
		return JSON.parse(text) as { status?: string; error?: string };
	} catch {
		return {};
	}
}

describe("sessions_send access guard", () => {
	it("refuses cross-agent target when A2A disabled (status=forbidden)", async () => {
		const tool = createSessionsSendTool({
			agentSessionKey: CALLER_KEY,
			visibility: ALL_VISIBILITY,
			a2aPolicy: POLICY_DISABLED,
		});
		const res = await tool.execute({
			sessionKey: TARGET_OTHER_AGENT_KEY,
			message: "hello",
		});
		const payload = parseEnvelope(res.content);
		assert.equal(payload.status, "forbidden");
		assert.match(payload.error ?? "", /sessions_send forbidden/);
	});

	it("refuses cross-agent target when visibility=self (no `all` scope)", async () => {
		const tool = createSessionsSendTool({
			agentSessionKey: CALLER_KEY,
			visibility: SELF_VISIBILITY,
			a2aPolicy: POLICY_ENABLED_ALL,
		});
		const res = await tool.execute({
			sessionKey: TARGET_OTHER_AGENT_KEY,
			message: "hello",
		});
		const payload = parseEnvelope(res.content);
		assert.equal(payload.status, "forbidden");
	});
});

describe("sessions_history access guard", () => {
	it("refuses cross-agent target when A2A disabled", async () => {
		const tool = createSessionsHistoryTool({
			agentSessionKey: CALLER_KEY,
			visibility: ALL_VISIBILITY,
			a2aPolicy: POLICY_DISABLED,
		});
		const res = await tool.execute({ sessionKey: TARGET_OTHER_AGENT_KEY });
		const payload = parseEnvelope(res.content);
		assert.equal(payload.status, "forbidden");
		assert.match(payload.error ?? "", /sessions_history forbidden/);
	});

	it("allows reading the caller's own session (same key)", async () => {
		const tool = createSessionsHistoryTool({
			agentSessionKey: CALLER_KEY,
			visibility: SELF_VISIBILITY,
			a2aPolicy: POLICY_DISABLED,
		});
		// Stub the gateway caller so the tool's execute body resolves quickly.
		let calls = 0;
		setGlobalGatewayCaller({
			async call() {
				calls += 1;
				return { messages: [] } as never;
			},
		});
		try {
			const res = await tool.execute({ sessionKey: CALLER_KEY });
			const payload = parseEnvelope(res.content);
			// Same-key fast path inside checkSessionToolAccess returns allowed=true
			// → execute body proceeds + calls gateway → returns normally (no
			// `forbidden` status).
			assert.notEqual(payload.status, "forbidden");
			assert.equal(calls, 1);
		} finally {
			resetGatewayCallerForTests();
		}
	});
});

describe("sessions_list access guard", () => {
	it("filters cross-agent rows out of the result when A2A disabled", async () => {
		setGlobalGatewayCaller({
			async call() {
				return {
					sessions: [
						{ sessionKey: CALLER_KEY, agentId: "alice" },
						{ sessionKey: TARGET_OTHER_AGENT_KEY, agentId: "bob" },
					],
				} as never;
			},
		});
		try {
			const tool = createSessionsListTool({
				agentSessionKey: CALLER_KEY,
				visibility: SELF_VISIBILITY,
				a2aPolicy: POLICY_DISABLED,
			});
			const res = await tool.execute({});
			const payload = JSON.parse(res.content) as {
				sessions: Array<{ sessionKey: string }>;
				count: number;
			};
			// Cross-agent row dropped; caller's own row survives.
			assert.equal(payload.count, 1);
			assert.equal(payload.sessions[0]?.sessionKey, CALLER_KEY);
		} finally {
			resetGatewayCallerForTests();
		}
	});
});

describe("sessions_spawn access guard", () => {
	it("refuses cross-agent spawn when A2A disabled", async () => {
		const tool = createSessionsSpawnTool({
			agentSessionKey: CALLER_KEY,
			requesterAgentIdOverride: "alice",
			visibility: ALL_VISIBILITY,
			a2aPolicy: POLICY_DISABLED,
		});
		const res = await tool.execute({
			task: "do something",
			agentId: "bob",
		});
		const payload = parseEnvelope(res.content);
		assert.equal(payload.status, "forbidden");
		assert.match(payload.error ?? "", /sessions_send forbidden/);
	});

	it("allows in-agent spawn (no agentId override)", async () => {
		// We can't easily test the happy path without spinning up the spawn
		// engine. The negative path above is what locks the guard down; the
		// positive path is exercised by the existing subagent-spawn tests
		// which already pass through the same factory without an `agentId`
		// arg. Smoke-check: factory accepts the options.
		const tool = createSessionsSpawnTool({
			agentSessionKey: CALLER_KEY,
			requesterAgentIdOverride: "alice",
			visibility: SELF_VISIBILITY,
			a2aPolicy: POLICY_DISABLED,
		});
		assert.equal(tool.name, "sessions_spawn");
	});
});

describe("fail-closed default — no policy supplied refuses the call", () => {
	it("history tool without visibility+policy is forbidden by default", async () => {
		const tool = createSessionsHistoryTool({
			agentSessionKey: CALLER_KEY,
			// No visibility, no policy → fail-closed
		});
		const res = await tool.execute({ sessionKey: TARGET_OTHER_AGENT_KEY });
		const payload = parseEnvelope(res.content);
		assert.equal(payload.status, "forbidden");
		assert.match(payload.error ?? "", /not configured/);
	});

	it("history tool with bypassAccessGuard:true still resolves (trusted internal pathway)", async () => {
		setGlobalGatewayCaller({
			async call() {
				return { messages: [] } as never;
			},
		});
		try {
			const tool = createSessionsHistoryTool({
				agentSessionKey: CALLER_KEY,
				bypassAccessGuard: true,
			});
			const res = await tool.execute({ sessionKey: TARGET_OTHER_AGENT_KEY });
			const payload = parseEnvelope(res.content);
			assert.notEqual(payload.status, "forbidden");
		} finally {
			resetGatewayCallerForTests();
		}
	});
});

// Silence the same-agent allow-list reference (lint).
void TARGET_SAME_AGENT_KEY;
