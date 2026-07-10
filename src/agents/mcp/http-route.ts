// src/agents/mcp/http-route.ts
//
// The gateway HTTP transport for the MCP tool-plane. Registers a single prefix
// route `/mcp/<token>` on the gateway's existing loopback HTTP server. The
// `<token>` is the single-use per-turn credential the agent-loop minted (see
// tool-plane-host.ts); it both AUTHENTICATES the caller (only the binary we
// spawned holds it) and SELECTS the turn context (whose tools + guard we serve).
//
// Transport: minimal MCP "Streamable HTTP". The `claude` binary POSTs one
// JSON-RPC request per call; we answer with a single `application/json` JSON-RPC
// response (the spec permits a JSON answer instead of an SSE stream when the
// server doesn't push server→client messages). Notifications get 202. A GET (the
// optional server→client SSE channel) gets 405 — we never initiate, which the
// client must tolerate per spec.
//
// Defense in depth: loopback-only (mirrors the gateway's operator-auth check) +
// the 256-bit token + the registry's format guard. An unknown/expired token is
// 404 (indistinguishable from a wrong path — no oracle).

import type { IncomingMessage, ServerResponse } from "node:http";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { HttpRoute } from "../extensions/types.js";
import { buildMcpTurnServer } from "./route.js";
import type { JsonRpcRequest, McpServer } from "./protocol.js";
import type { McpTurnContext, McpTurnRegistry } from "./tool-plane-host.js";
import { pauseHarnessWatchdog } from "../harness/watchdog.js";

const log = createSubsystemLogger("mcp/tool-plane");

// One MCP server per TURN, not per request. `buildMcpTurnServer` maps every tool
// (31 of them) into MCP shape; rebuilding that on each `tools/call` is pure
// waste on a chatty turn. Keyed by the turn context object, so it dies with the
// turn — no eviction needed.
const serverByTurn = new WeakMap<McpTurnContext, McpServer>();
function turnServer(turn: McpTurnContext): McpServer {
	let s = serverByTurn.get(turn);
	if (!s) {
		s = buildMcpTurnServer(turn);
		serverByTurn.set(turn, s);
	}
	return s;
}

/** The URL prefix the tool-plane is served under. */
export const MCP_ROUTE_PREFIX = "/mcp";

/**
 * Wall-clock budget for one `tools/call`.
 *
 * The gateway dispatcher races every route handler against
 * `route.timeoutMs ?? DEFAULT_TIMEOUT_MS` (30s) and, on expiry, writes a 408 —
 * but `Promise.race` does NOT cancel the loser. With the default the plane was
 * badly broken: any tool slower than 30s (an exec-gated `bash` awaiting the
 * operator's 5-minute approval; `generate_video`, whose OWN budget is 1_220_000
 * ms) would hand the binary a non-JSON-RPC 408 while the tool kept running to
 * completion. The model is told the call failed, the side effect happens anyway
 * — a billed render discarded, or a shell command executed after the model gave
 * up on it, inviting a double-execution on retry.
 *
 * So we own the budget explicitly: larger than the largest per-tool ceiling, and
 * far larger than the approval window. Each tool still enforces its OWN timeout
 * (`wrapToolExecutionTimeout`), which is what should bound a call — this exists
 * only so the dispatcher can never guillotine an in-flight tool.
 */
export const MCP_ROUTE_TIMEOUT_MS = 1_800_000; // 30m > generate_video's 1_220_000ms

function isLoopback(remote: string | undefined): boolean {
	return (
		remote === "127.0.0.1" ||
		remote === "::1" ||
		remote === "::ffff:127.0.0.1" ||
		remote === "localhost"
	);
}

/**
 * Write a response ONLY if we still own it. Defence in depth: if anything ever
 * ends the response out from under us (a dispatcher timeout, a disconnected
 * client), a late write would throw ERR_STREAM_WRITE_AFTER_END deep inside an
 * orphaned promise chain — an unhandled rejection that can take the gateway
 * down. Dropping the write is always the right call: the peer is gone.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent || res.writableEnded) {
		log.debug("dropping mcp response — peer already gone");
		return;
	}
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(text);
}

function endPlain(res: ServerResponse, status: number, text?: string, headers?: Record<string, string>): void {
	if (res.headersSent || res.writableEnded) return;
	res.statusCode = status;
	for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
	res.end(text);
}

/**
 * Build the `/mcp` HttpRoute backed by `registry`. Pure of any gateway internals
 * beyond the Node req/res it's handed, so it unit-tests with fake req/res.
 */
export function createMcpHttpRoute(registry: McpTurnRegistry): HttpRoute {
	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// Loopback only — the bind is already 127.0.0.1; this is belt-and-suspenders
		// in case the bind guard is ever relaxed (same posture as auth:"operator").
		if (!isLoopback(req.socket.remoteAddress ?? "")) {
			log.warn("refused non-loopback mcp caller", { remote: req.socket.remoteAddress ?? "unknown" });
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}

		const reqPath = (req.url ?? "").split("?")[0] ?? "";
		// token = the path segment after `/mcp/`
		const token = reqPath.startsWith(`${MCP_ROUTE_PREFIX}/`)
			? reqPath.slice(MCP_ROUTE_PREFIX.length + 1).split("/")[0] ?? ""
			: "";
		const turn = registry.lookup(token);
		if (!turn) {
			// Unknown/expired/malformed token — 404 (no distinction: no oracle).
			// Never log the token itself; it is a live credential.
			log.debug("rejected mcp request with unknown/expired token");
			endPlain(res, 404, "Not found");
			return;
		}

		const method = (req.method ?? "GET").toUpperCase();
		if (method === "GET") {
			// Optional server→client SSE channel — we never push, so decline.
			endPlain(res, 405, "Method Not Allowed", { Allow: "POST" });
			return;
		}
		if (method === "DELETE") {
			// Session teardown — the turn's lifecycle owns disposal; ack politely.
			endPlain(res, 200);
			return;
		}
		if (method !== "POST") {
			endPlain(res, 405, "Method Not Allowed", { Allow: "POST" });
			return;
		}

		// Body was pre-buffered by the gateway dispatcher onto `req.body`.
		const bodyBuf = (req as IncomingMessage & { body?: Buffer }).body;
		let rpc: JsonRpcRequest;
		try {
			rpc = JSON.parse((bodyBuf ?? Buffer.alloc(0)).toString("utf8")) as JsonRpcRequest;
		} catch {
			sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}

		// Observability: without this the tool-plane is a black box — an operator
		// seeing "the agent didn't use its tools" has nothing to look at. Log the
		// tool NAME only (arguments can carry user content; the token is a secret).
		const calledTool =
			rpc?.method === "tools/call"
				? (rpc.params as { name?: unknown } | undefined)?.name
				: undefined;

		// The handshake is the ONE unambiguous proof that the binary loaded our
		// server. It matters: a full-plane spawn denies every built-in the binary
		// ships, so if the MCP config were ever rejected the agent would have NO
		// tools at all — which looks exactly like an agent that won't use them.
		// Seeing this line (and its tool count) settles that in one glance.
		if (rpc?.method === "initialize") {
			log.info("tool-plane connected", {
				agentId: turn.agentId,
				...(turn.sessionKey !== undefined ? { sessionKey: turn.sessionKey } : {}),
				tools: turn.customTools.length,
			});
		}
		// Per-call cancellation. The turn's signal alone is not enough: if the
		// `claude` child dies (watchdog SIGKILL, turn abort) the socket closes, and
		// without this the tool would keep running — executing a shell command or a
		// billed render whose result nobody will ever read. Chain BOTH sources.
		const ac = new AbortController();
		const abort = (): void => {
			if (!ac.signal.aborted) ac.abort();
		};
		if (turn.signal) {
			if (turn.signal.aborted) abort();
			else turn.signal.addEventListener("abort", abort, { once: true });
		}
		const onClose = (): void => {
			// `close` also fires on a normal completed response — only abort when the
			// peer vanished before we answered.
			if (!res.writableEnded) abort();
		};
		req.on("close", onClose);

		// While WE run the tool, the harness child sits silent, blocked on this
		// response. Its liveness watchdogs would kill it for waiting on us — a
		// `spawn_agent` runs a whole sub-agent turn (which may itself pause on two
		// five-minute approvals), `generate_video` has a 20-minute budget of its
		// own. Suspend them for exactly this window; every tool already carries its
		// own timeout, so the child is never left unbounded. No-op for the
		// memory-only stdio plane, which has no token.
		const resumeWatchdog = typeof calledTool === "string" ? pauseHarnessWatchdog(token) : () => {};

		const started = Date.now();
		let response: Awaited<ReturnType<McpServer["handle"]>>;
		try {
			const server = turnServer(turn);
			response = await server.handle(rpc, ac.signal);
		} finally {
			resumeWatchdog();
			req.off("close", onClose);
			turn.signal?.removeEventListener("abort", abort);
		}
		if (typeof calledTool === "string") {
			const result = (response?.result ?? {}) as { isError?: boolean };
			log.info("tool call", {
				tool: calledTool,
				agentId: turn.agentId,
				...(turn.sessionKey !== undefined ? { sessionKey: turn.sessionKey } : {}),
				ms: Date.now() - started,
				...(result.isError ? { blockedOrFailed: true } : {}),
				...(response?.error ? { rpcError: response.error.code } : {}),
			});
		}
		if (response === null) {
			// Notification — accepted, no body.
			res.statusCode = 202;
			res.end();
			return;
		}
		sendJson(res, 200, response);
	};

	return {
		method: undefined, // accept POST/GET/DELETE; the handler branches
		path: MCP_ROUTE_PREFIX,
		match: "prefix",
		auth: "none", // own token + loopback check inside the handler
		skipSessionGuard: true, // JSON-RPC body has no sessionKey/agentId targeting
		// Own the wall-clock budget — the 30s default would 408 the binary out from
		// under a still-running tool. See MCP_ROUTE_TIMEOUT_MS.
		timeoutMs: MCP_ROUTE_TIMEOUT_MS,
		handler: handler as HttpRoute["handler"],
	};
}
