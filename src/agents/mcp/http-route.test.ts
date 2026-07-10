import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import { createMcpHttpRoute, MCP_ROUTE_TIMEOUT_MS } from "./http-route.js";
import { createMcpTurnRegistry, type McpTurnContext } from "./tool-plane-host.js";
import type { AnyBrigadeTool } from "../tools/types.js";

function fakeReq(over: { method?: string; url?: string; body?: unknown; remote?: string }) {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		method: over.method ?? "POST",
		url: over.url ?? "/mcp/x",
		socket: { remoteAddress: over.remote ?? "127.0.0.1" },
		headers: { "content-type": "application/json" },
		body: over.body !== undefined ? Buffer.from(JSON.stringify(over.body)) : undefined,
		on(ev: string, fn: () => void) {
			(listeners[ev] ??= []).push(fn);
		},
		off(ev: string, fn: () => void) {
			listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
		},
		emit(ev: string) {
			for (const fn of listeners[ev] ?? []) fn();
		},
	} as never;
}

function fakeRes() {
	const state: { statusCode: number; headers: Record<string, string>; body: string } = {
		statusCode: 0,
		headers: {},
		body: "",
	};
	let ended = false;
	const res = {
		set statusCode(v: number) {
			state.statusCode = v;
		},
		get statusCode() {
			return state.statusCode;
		},
		get headersSent() {
			return ended;
		},
		get writableEnded() {
			return ended;
		},
		setHeader(k: string, v: string) {
			state.headers[k.toLowerCase()] = v;
		},
		end(s?: string) {
			if (ended) throw new Error("ERR_STREAM_WRITE_AFTER_END");
			ended = true;
			if (s) state.body = s;
		},
	};
	return { res: res as never, state, endIt: () => { ended = true; } };
}

function echoTool(calls: string[]): AnyBrigadeTool {
	return {
		name: "echo",
		label: "echo",
		description: "echo",
		parameters: Type.Object({ text: Type.Optional(Type.String()) }),
		execute: async (_id: string, params: any) => {
			calls.push(params?.text ?? "");
			return { content: [{ type: "text", text: `echo:${params?.text ?? ""}` }], details: undefined };
		},
	} as AnyBrigadeTool;
}

function registerTurn(over: Partial<McpTurnContext> = {}) {
	const registry = createMcpTurnRegistry();
	const reg = registry.register({ customTools: [], guard: async () => undefined, agentId: "main", ...over });
	return { registry, token: reg.token, reg };
}

test("POST tools/call on a valid token runs the tool and returns JSON-RPC", async () => {
	const calls: string[] = [];
	const { registry, token } = registerTurn({ customTools: [echoTool(calls)] });
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({
			url: `/mcp/${token}`,
			body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
		}),
		res,
	);
	assert.equal(state.statusCode, 200);
	assert.equal(JSON.parse(state.body).result.content[0].text, "echo:hi");
	assert.deepEqual(calls, ["hi"]);
});

test("unknown token → 404 (no oracle)", async () => {
	const { registry } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ url: "/mcp/deadbeef", body: { jsonrpc: "2.0", id: 1, method: "ping" } }), res);
	assert.equal(state.statusCode, 404);
});

test("disposed token stops resolving (turn ended)", async () => {
	const { registry, token, reg } = registerTurn();
	reg.dispose();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", id: 1, method: "ping" } }), res);
	assert.equal(state.statusCode, 404);
});

test("non-loopback caller → 401", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({ url: `/mcp/${token}`, remote: "8.8.8.8", body: { jsonrpc: "2.0", id: 1, method: "ping" } }),
		res,
	);
	assert.equal(state.statusCode, 401);
});

test("GET (server→client SSE) → 405; we never push", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ method: "GET", url: `/mcp/${token}` }), res);
	assert.equal(state.statusCode, 405);
});

test("notification (no id) → 202 no body", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", method: "notifications/initialized" } }),
		res,
	);
	assert.equal(state.statusCode, 202);
	assert.equal(state.body, "");
});

test("malformed JSON body → -32700 parse error", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	const req = fakeReq({ url: `/mcp/${token}` });
	(req as any).body = Buffer.from("{not json");
	await (route.handler as any)(req, res);
	assert.equal(state.statusCode, 400);
	assert.equal(JSON.parse(state.body).error.code, -32700);
});

/* ─────────────── budget, response-lifecycle + cancellation ─────────────── */

// The gateway dispatcher races the handler against `route.timeoutMs ?? 30_000`
// and does NOT cancel the loser. Our budget must exceed the slowest tool, or a
// still-running (billed) tool gets a 408 sent out from under it.
const LARGEST_TOOL_BUDGET_MS = 1_220_000; // generate_video (session-wiring.ts)
const EXEC_GATE_APPROVAL_MS = 5 * 60 * 1000;

test("route owns a budget larger than the slowest tool and the approval window", () => {
	const { registry } = registerTurn();
	const route = createMcpHttpRoute(registry);
	assert.equal(route.timeoutMs, MCP_ROUTE_TIMEOUT_MS, "route must not inherit the 30s default");
	assert.ok(MCP_ROUTE_TIMEOUT_MS > LARGEST_TOOL_BUDGET_MS, "must outlast generate_video");
	assert.ok(MCP_ROUTE_TIMEOUT_MS > EXEC_GATE_APPROVAL_MS, "must outlast an operator approval");
});

test("a response written after the peer is gone is dropped, not thrown", async () => {
	const { registry, token } = registerTurn({ customTools: [echoTool([])] });
	const route = createMcpHttpRoute(registry);
	const { res, state, endIt } = fakeRes();
	endIt(); // simulate the dispatcher/peer already ending the response
	await assert.doesNotReject(() =>
		(route.handler as any)(
			fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", id: 1, method: "ping" } }),
			res,
		),
	);
	assert.equal(state.body, "", "nothing written after end");
});

test("client disconnect aborts the in-flight tool (no ghost execution)", async () => {
	let sawAborted: boolean | undefined;
	const tool = {
		name: "slow",
		label: "slow",
		description: "slow",
		parameters: { type: "object", properties: {} },
		execute: async (_id: string, _p: unknown, signal?: AbortSignal) => {
			// the request is aborted while we're "running"
			await new Promise((r) => setTimeout(r, 5));
			sawAborted = signal?.aborted;
			return { content: [{ type: "text", text: "done" }], details: undefined };
		},
	} as unknown as AnyBrigadeTool;
	const { registry, token } = registerTurn({ customTools: [tool] });
	const route = createMcpHttpRoute(registry);
	const { res } = fakeRes();
	const req = fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } } });
	const p = (route.handler as any)(req, res);
	(req as any).emit("close"); // peer vanished (claude child SIGKILLed / turn aborted)
	await p;
	assert.equal(sawAborted, true, "tool must observe the abort when the peer disconnects");
});

test("turn-level abort propagates into the tool call", async () => {
	let sawAborted: boolean | undefined;
	const tool = {
		name: "probe",
		label: "probe",
		description: "probe",
		parameters: { type: "object", properties: {} },
		execute: async (_id: string, _p: unknown, signal?: AbortSignal) => {
			sawAborted = signal?.aborted;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	} as unknown as AnyBrigadeTool;
	const ac = new AbortController();
	ac.abort();
	const { registry, token } = registerTurn({ customTools: [tool], signal: ac.signal });
	const route = createMcpHttpRoute(registry);
	const { res } = fakeRes();
	await (route.handler as any)(
		fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {} } } }),
		res,
	);
	assert.equal(sawAborted, true);
});
