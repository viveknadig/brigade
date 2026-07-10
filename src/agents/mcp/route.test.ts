import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import { buildMcpTurnServer } from "./route.js";
import { onAgentEvent } from "../agent-event-bus.js";
import type { McpTurnContext } from "./tool-plane-host.js";
import type { AnyBrigadeTool } from "../tools/types.js";

// Minimal fake Brigade tool — records calls + returns text content.
function fakeTool(name: string, over: Partial<AnyBrigadeTool> = {}, calls: string[] = []): AnyBrigadeTool {
	return {
		name,
		label: name,
		description: `the ${name} tool`,
		parameters: Type.Object({ text: Type.Optional(Type.String()) }),
		execute: async (_callId: string, params: unknown) => {
			calls.push(`${name}:${JSON.stringify(params)}`);
			return { content: [{ type: "text", text: `${name} ran` }], details: undefined };
		},
		...over,
	} as AnyBrigadeTool;
}

const req = (method: string, params?: unknown, id: string | number = 1) => ({ jsonrpc: "2.0" as const, id, method, params });

function turn(over: Partial<McpTurnContext>): McpTurnContext {
	return { customTools: [], guard: async () => undefined, agentId: "main", ...over };
}

test("tools/list surfaces the turn's tools with their schemas", async () => {
	const server = buildMcpTurnServer(turn({ customTools: [fakeTool("write_memory"), fakeTool("spawn_agent")] }));
	const res = await server.handle(req("tools/list"));
	const names = (res?.result as any).tools.map((t: any) => t.name);
	assert.deepEqual(names, ["write_memory", "spawn_agent"]);
	assert.equal((res?.result as any).tools[0].inputSchema.type, "object");
});

test("tools/call runs the guard THEN execute, returns content", async () => {
	const order: string[] = [];
	const calls: string[] = [];
	const tool = fakeTool("write_memory", {}, calls);
	const guard = async (ctx: any) => {
		order.push(`guard:${ctx.toolCall.name}`);
		return undefined; // pass
	};
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const res = await server.handle(req("tools/call", { name: "write_memory", arguments: { text: "hi" } }));
	assert.equal((res?.result as any).content[0].text, "write_memory ran");
	assert.equal((res?.result as any).isError, undefined);
	assert.deepEqual(order, ["guard:write_memory"]);
	assert.deepEqual(calls, ['write_memory:{"text":"hi"}'], "execute got the args");
});

test("guard BLOCK short-circuits — execute never runs, reason surfaces as isError", async () => {
	const calls: string[] = [];
	const tool = fakeTool("bash", {}, calls);
	const guard = async () => ({ block: true as const, reason: "Command needs approval." });
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const res = await server.handle(req("tools/call", { name: "bash", arguments: { command: "rm -rf /" } }));
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /needs approval/);
	assert.deepEqual(calls, [], "execute must NOT run when the guard blocks");
});

test("ownerOnly refusal (execute throws) surfaces as isError with the message", async () => {
	const tool = fakeTool("manage_provider", {
		execute: async () => {
			throw new Error("Tool restricted to the workspace owner.");
		},
	});
	const server = buildMcpTurnServer(turn({ customTools: [tool] }));
	const res = await server.handle(req("tools/call", { name: "manage_provider", arguments: {} }));
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /restricted to the workspace owner/);
});

test("an already-aborted signal reaches the guard, and execute is short-circuited", async () => {
	// Matches Pi's prepareToolCall: the signal is threaded into the guard, then
	// re-checked before execute — so an aborted turn never runs the tool.
	const seen: Record<string, boolean> = {};
	const tool = fakeTool("slow", {
		execute: async (_id: string, _p: unknown, signal?: AbortSignal) => {
			seen.execute = !!signal?.aborted;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	});
	const guard = async (_ctx: any, signal?: AbortSignal) => {
		seen.guard = !!signal?.aborted;
		return undefined;
	};
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const ac = new AbortController();
	ac.abort();
	const res = await server.handle(req("tools/call", { name: "slow", arguments: {} }), ac.signal);
	assert.equal(seen.guard, true, "guard still sees the signal");
	assert.equal(seen.execute, undefined, "execute must NOT run for an aborted turn");
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /aborted/i);
});

test("a tool not in the turn's set is unknown (-32602), never fabricated", async () => {
	const server = buildMcpTurnServer(turn({ customTools: [fakeTool("write_memory")] }));
	const res = await server.handle(req("tools/call", { name: "send_message", arguments: {} }));
	assert.equal(res?.error?.code, -32602);
});

/* ────────── parity with Pi's prepareToolCall pipeline (agent-loop.js) ────────── */

function strictTool(seen: any[] = []): AnyBrigadeTool {
	return {
		name: "shell",
		label: "shell",
		description: "runs a command",
		parameters: Type.Object({ command: Type.String() }),
		execute: async (_id: string, params: any, signal?: AbortSignal) => {
			seen.push({ params, aborted: signal?.aborted });
			return { content: [{ type: "text", text: "ran" }], details: undefined };
		},
	} as AnyBrigadeTool;
}

test("args are validated against the schema BEFORE execute (missing required → tool error)", async () => {
	const seen: any[] = [];
	const server = buildMcpTurnServer(turn({ customTools: [strictTool(seen)] }));
	const res = await server.handle(req("tools/call", { name: "shell", arguments: {} }));
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /required/i);
	assert.deepEqual(seen, [], "execute must not run on invalid args");
});

test("the guard context mirrors Pi's split exactly: RAW in toolCall, VALIDATED in args", async () => {
	const guardSawToolCall: unknown[] = [];
	const guardSawArgs: unknown[] = [];
	const seen: any[] = [];
	const guard = async (ctx: any) => {
		guardSawToolCall.push(ctx.toolCall.arguments);
		guardSawArgs.push(ctx.args);
		return undefined;
	};
	const server = buildMcpTurnServer(turn({ customTools: [strictTool(seen)], guard }));
	// The binary sends a number. Pi's own loop hands `beforeToolCall` the ORIGINAL
	// toolCall and puts the coerced args only in `ctx.args` (agent-loop.js passes
	// `toolCall`, not `preparedToolCall`). Brigade's guards read `ctx.toolCall.arguments`
	// first, so coercing there would make the exec-gate see "42" over MCP but 42 in a
	// Pi-loop turn — a different branch, and a different loop-detector hash.
	await server.handle(req("tools/call", { name: "shell", arguments: { command: 42 } }));
	assert.deepEqual(guardSawToolCall, [{ command: 42 }], "toolCall carries the RAW arguments, as Pi's does");
	assert.deepEqual(guardSawArgs, [{ command: "42" }], "ctx.args carries the validated+coerced arguments");
	assert.equal(seen[0].params.command, "42", "execute still receives the validated args");
});

test("an abort between guard and execute prevents the tool from running", async () => {
	const seen: any[] = [];
	const ac = new AbortController();
	// the guard is where an approval would block; abort while it is 'waiting'
	const guard = async () => {
		ac.abort();
		return undefined;
	};
	const server = buildMcpTurnServer(turn({ customTools: [strictTool(seen)], guard }));
	const res = await server.handle(req("tools/call", { name: "shell", arguments: { command: "rm -rf /" } }), ac.signal);
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /aborted/i);
	assert.deepEqual(seen, [], "no ghost execution after abort");
});

test("image results pass through as MCP image content, not a placeholder", async () => {
	const imgTool = {
		name: "analyze_media",
		label: "analyze_media",
		description: "img",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [
				{ type: "text", text: "here it is" },
				{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			],
			details: undefined,
		}),
	} as unknown as AnyBrigadeTool;
	const server = buildMcpTurnServer(turn({ customTools: [imgTool] }));
	const res = await server.handle(req("tools/call", { name: "analyze_media", arguments: {} }));
	const content = (res?.result as any).content;
	assert.equal(content[0].type, "text");
	assert.deepEqual(content[1], { type: "image", data: "AAAA", mimeType: "image/jpeg" });
});

/* ────────── synthetic tool events (live TUI chips on claude-cli) ────────── */

function captureBusEvents(): { events: any[]; stop: () => void } {
	const events: any[] = [];
	const stop = onAgentEvent((e: any) => {
		if (e.type === "pi") events.push(e);
	});
	return { events, stop };
}

test("a tool call mints synthetic pi start/end events the TUI already renders", async () => {
	const { events, stop } = captureBusEvents();
	try {
		const server = buildMcpTurnServer(
			turn({ customTools: [fakeTool("write_memory")], agentId: "main", sessionKey: "agent:main:main", runId: "run-1" }),
		);
		await server.handle(req("tools/call", { name: "write_memory", arguments: { text: "hi" } }));
	} finally {
		stop();
	}
	assert.equal(events.length, 2, "exactly one start and one end");
	const [start, end] = events;
	assert.equal(start.synthetic, true, "must be marked synthetic (excluded from seq)");
	assert.equal(start.runId, "run-1");
	assert.equal(start.sessionId, "agent:main:main");
	assert.equal(start.piEvent.type, "tool_execution_start");
	assert.equal(start.piEvent.toolName, "write_memory");
	assert.equal(end.piEvent.type, "tool_execution_end");
	assert.equal(end.piEvent.isError, false);
	// the TUI correlates the chip by toolCallId — they must match
	assert.equal(start.piEvent.toolCallId, end.piEvent.toolCallId);
	// connect.ts feeds `result` to summarizeToolResult(): needs Pi's {content:[…]} shape
	assert.equal(end.piEvent.result.content[0].text, "write_memory ran");
});

test("a tool's onUpdate progress is teed onto the bus, as Pi's loop does", async () => {
	const { events, stop } = captureBusEvents();
	try {
		// Pi passes `onUpdate` as the 4th arg to execute; `bash` streams partial output
		// through it and `web-fetch` reports "fetching → extracting". Dropping it made a
		// long tool look like a hang: a start chip, silence, then a result.
		const streaming: AnyBrigadeTool = {
			name: "bash",
			label: "bash",
			description: "runs a command",
			parameters: Type.Object({ command: Type.Optional(Type.String()) }),
			execute: async (_id: string, _p: unknown, _sig: unknown, onUpdate?: (u: unknown) => void) => {
				onUpdate?.({ type: "output", text: "compiling…" });
				onUpdate?.({ type: "output", text: "linking…" });
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		} as unknown as AnyBrigadeTool;
		const server = buildMcpTurnServer(turn({ customTools: [streaming], runId: "run-1" }));
		await server.handle(req("tools/call", { name: "bash", arguments: { command: "make" } }));
	} finally {
		stop();
	}
	const updates = events.filter((e: any) => e.piEvent.type === "tool_execution_update");
	assert.equal(updates.length, 2, "both progress updates reached the TUI");
	assert.equal(updates[0].piEvent.update.text, "compiling…");
	assert.equal(updates[0].synthetic, true, "still excluded from the seq'd stream");
	// order: start → update → update → end
	assert.deepEqual(
		events.map((e: any) => e.piEvent.type),
		["tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end"],
	);
});

test("a SUB-AGENT's tool events carry its depth, so the TUI indents them", async () => {
	const { events, stop } = captureBusEvents();
	try {
		// Without this a claude-cli sub-agent's `bash` renders at top level, exactly as
		// if the parent had run it. A Pi-loop sub-agent's real events carry the depth.
		const server = buildMcpTurnServer(
			turn({ customTools: [fakeTool("read")], runId: "run-1", subagentDepth: 1, subagentLabel: "researcher" }),
		);
		await server.handle(req("tools/call", { name: "read", arguments: {} }));
	} finally {
		stop();
	}
	assert.ok(events.length > 0);
	for (const e of events as any[]) {
		assert.equal(e.subagentDepth, 1);
		assert.equal(e.subagentLabel, "researcher");
	}
});

test("a top-level turn's events carry NO depth (absent, not zero)", async () => {
	const { events, stop } = captureBusEvents();
	try {
		const server = buildMcpTurnServer(turn({ customTools: [fakeTool("read")], runId: "run-1" }));
		await server.handle(req("tools/call", { name: "read", arguments: {} }));
	} finally {
		stop();
	}
	for (const e of events as any[]) assert.equal("subagentDepth" in e, false);
});

test("a BLOCKED call emits no tool events (matches Pi: a block yields no start/end)", async () => {
	const { events, stop } = captureBusEvents();
	try {
		const guard = async () => ({ block: true as const, reason: "needs approval" });
		const server = buildMcpTurnServer(turn({ customTools: [fakeTool("bash")], guard, runId: "run-2" }));
		await server.handle(req("tools/call", { name: "bash", arguments: { text: "x" } }));
	} finally {
		stop();
	}
	assert.deepEqual(events, [], "no chip for a call that never ran");
});

test("a failing tool ends with isError so the TUI paints ✗", async () => {
	const { events, stop } = captureBusEvents();
	try {
		const boom = fakeTool("bad", {
			execute: async () => {
				throw new Error("kaboom");
			},
		});
		const server = buildMcpTurnServer(turn({ customTools: [boom], runId: "run-3" }));
		await server.handle(req("tools/call", { name: "bad", arguments: {} }));
	} finally {
		stop();
	}
	const end = events.at(-1);
	assert.equal(end.piEvent.isError, true);
	assert.match(end.piEvent.result.content[0].text, /kaboom/);
});

test("no runId (cold `brigade agent` path) → no events, no crash", async () => {
	const { events, stop } = captureBusEvents();
	try {
		const server = buildMcpTurnServer(turn({ customTools: [fakeTool("write_memory")] })); // runId undefined
		const res = await server.handle(req("tools/call", { name: "write_memory", arguments: {} }));
		assert.equal((res?.result as any).content[0].text, "write_memory ran", "tool still runs");
	} finally {
		stop();
	}
	assert.deepEqual(events, []);
});
