// src/agents/mcp/tool-plane-host.ts
//
// The gateway-hosted MCP tool-plane's per-turn registry + process-global host
// handle.
//
// WHY THIS EXISTS: to expose Brigade's FULL tool surface to the claude-cli
// binary without weakening a single guard, the MCP endpoint must run INSIDE the
// gateway process (that's where the live singletons — cron/channel/registry —
// and the approval bridge live). But a tool's authorization, exec-approval, and
// memory ORIGIN are per-TURN closure state (owner vs peer, this session's
// channelContext), not ambient. So we do NOT rebuild the toolset in the MCP
// host; instead, for each eligible turn the agent-loop REGISTERS the turn's
// already-built `customTools` + `beforeToolCall` guard here under a single-use
// token, and the `/mcp` route resolves that token per request. Every `tools/call`
// then runs the turn's OWN guard + the turn's OWN tool object — byte-identical to
// a Pi-loop dispatch (ownerOnly wrap, exec-gate, origin, timeouts all inherited).
//
// The host handle is a process-global set only by the gateway at boot (mirrors
// `getActiveApprovalBridge()` / `getActiveCronService()`), so on the cold
// `brigade agent` path — which has no HTTP server and no approval bridge — it is
// `null` and the agent-loop simply skips the tool-plane (fail-open).

import { randomBytes } from "node:crypto";

import type { BrigadeBeforeToolCallHook } from "../tool-guard.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import type { HarnessToolRecord } from "../harness-transcript.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/**
 * The execution context of ONE turn, captured by reference. The `/mcp` route
 * needs exactly this to serve the binary's callbacks with the turn's real
 * authorization + guards.
 */
export interface McpTurnContext {
	/** The turn's tools — ALREADY ownerOnly-wrapped + timeout-wrapped + origin-bound
	 *  by `assembleBrigadeToolset` for this turn's senderIsOwner/channelContext. */
	customTools: AnyBrigadeTool[];
	/** The turn's composed guard chain (unknown-tool → path-write → cmd-ism →
	 *  config-write → loop → exec-gate). Closes over the turn's `gateCtxRef`, so it
	 *  routes approval prompts to the right operator. Run this BEFORE any execute. */
	guard: BrigadeBeforeToolCallHook;
	/** The turn's abort signal (per-call controllers chain to it). */
	signal?: AbortSignal;
	/** For diagnostics / logging correlation only — never a trust input. */
	agentId: string;
	sessionKey?: string;
	/** The turn's run id. Present when the loop registered us (always, in the
	 *  gateway); required to mint pi-shaped tool events the TUI can render. */
	runId?: string;
	/**
	 * Sub-agent nesting of the turn we serve, mirrored onto every synthetic tool
	 * event. A Pi-loop sub-agent's tool events carry these, and the TUI indents by
	 * them; a harness sub-agent's calls would otherwise render as if the parent had
	 * made them. Absent on a top-level turn.
	 */
	subagentDepth?: number;
	subagentLabel?: string;
	/**
	 * Report a completed tool call so the harness-transcript layer can record it
	 * (see `../harness-transcript.ts`). Without this the session transcript for a
	 * claude-cli turn holds only the model's prose — a resumed session would not
	 * know a file was written. Best-effort: never throws into the tool call.
	 */
	recordToolCall?: (rec: HarnessToolRecord) => void;
}

/** A live registration. `dispose()` is idempotent; the agent-loop calls it in
 *  its `finally`, so a token never outlives its turn. */
export interface McpTurnRegistration {
	token: string;
	dispose(): void;
}

export interface McpTurnRegistry {
	register(ctx: McpTurnContext): McpTurnRegistration;
	lookup(token: string): McpTurnContext | undefined;
	/** Live registration count (diagnostics/tests). */
	size(): number;
}

/**
 * Backstop bounds. The agent-loop disposes every token in its `finally`, so in
 * normal operation the registry holds only the in-flight turns. These caps exist
 * because a leaked entry retains the WHOLE turn context (customTools + guard +
 * signal) for the gateway's lifetime — a slow leak would be a real memory
 * problem on a long-lived daemon.
 *
 * The TTL measures IDLE time, not age. It cannot be an age cap: a turn's wall
 * clock is unbounded by design, because the child's watchdogs are PAUSED for the
 * duration of every tool call (see `pauseHarnessWatchdog`) and the hard ceiling
 * slides by the paused span. A turn that chains three `generate_video` calls
 * (~20m each) legitimately outlives any fixed age cap, and evicting its token
 * mid-turn would 404 every subsequent `tools/call` — stripping a full-plane agent
 * of its ENTIRE tool surface, since the binary's own builtins are denied.
 *
 * Idle time is the honest signal: a live turn touches its token on every call.
 * The longest gap between touches is one tool's own duration, which no constant
 * here can bound (see MCP_ROUTE_TIMEOUT_MS). What DOES bound it is the harness's
 * unpausable absolute ceiling: no child survives past it, so a TTL matched to it
 * can never evict a token whose turn is still alive. Leaks are still collected —
 * within one ceiling, and under the hard cap.
 */
export const MCP_TURN_REGISTRY_MAX_ENTRIES = 128;
export const MCP_TURN_REGISTRY_TTL_MS = 4 * 60 * 60 * 1000; // 4h idle — matches the harness ceiling

interface Entry {
	ctx: McpTurnContext;
	/** Last time this token was looked up. Refreshed per call — the liveness signal. */
	lastSeenAt: number;
}

/** In-memory single-use token registry. Tokens are 256-bit; lookups are exact. */
export function createMcpTurnRegistry(
	opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): McpTurnRegistry {
	const entries = new Map<string, Entry>();
	const maxEntries = opts.maxEntries ?? MCP_TURN_REGISTRY_MAX_ENTRIES;
	const ttlMs = opts.ttlMs ?? MCP_TURN_REGISTRY_TTL_MS;
	const now = opts.now ?? (() => Date.now());

	const pruneExpired = (): void => {
		const cutoff = now() - ttlMs;
		for (const [token, e] of entries) {
			if (e.lastSeenAt <= cutoff) entries.delete(token);
		}
	};

	return {
		register(ctx: McpTurnContext): McpTurnRegistration {
			pruneExpired();
			// Hard cap: if a bug ever stops disposing, evict rather than grow without
			// bound — but evict the LEAST-RECENTLY-SEEN, never merely the oldest.
			// Insertion order is age, and age says nothing about liveness: the oldest
			// entry is often the long-running turn that is still actively calling tools.
			while (entries.size >= maxEntries) {
				let stalest: string | undefined;
				let stalestAt = Number.POSITIVE_INFINITY;
				for (const [token, e] of entries) {
					if (e.lastSeenAt < stalestAt) {
						stalestAt = e.lastSeenAt;
						stalest = token;
					}
				}
				if (stalest === undefined) break;
				entries.delete(stalest);
			}
			// 32 bytes = 256 bits of CSPRNG entropy → unguessable path token.
			const token = randomBytes(32).toString("hex");
			entries.set(token, { ctx, lastSeenAt: now() });
			let disposed = false;
			return {
				token,
				dispose(): void {
					if (disposed) return;
					disposed = true;
					entries.delete(token);
				},
			};
		},
		lookup(token: string): McpTurnContext | undefined {
			// Reject anything that isn't a well-formed token BEFORE the map hit, so a
			// malformed/empty path segment can never alias a live entry.
			if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return undefined;
			const e = entries.get(token);
			if (!e) return undefined;
			if (e.lastSeenAt <= now() - ttlMs) {
				entries.delete(token);
				return undefined;
			}
			// Touch: this token is demonstrably live, so the idle clock restarts.
			e.lastSeenAt = now();
			return e.ctx;
		},
		size(): number {
			return entries.size;
		},
	};
}

/** The gateway-published host handle: where the `/mcp` endpoint is reachable and
 *  the registry it resolves tokens against. */
export interface McpToolPlaneHost {
	/** Loopback base URL the binary connects back to, e.g. `http://127.0.0.1:7777`. */
	baseUrl: string;
	registry: McpTurnRegistry;
}

const HOST_KEY = Symbol.for("brigade.mcp.toolPlaneHost");

/** Publish (or clear, with `null`) the tool-plane host. Called ONLY by the
 *  gateway once its HTTP server is bound + the `/mcp` route is mounted. */
export function setActiveMcpToolPlaneHost(host: McpToolPlaneHost | null): void {
	resolveGlobalSingleton<{ value: McpToolPlaneHost | null }>(HOST_KEY, () => ({ value: null })).value = host;
}

/** Resolve the active host, or `null` when the loop runs outside a gateway
 *  (cold `brigade agent` path) — in which case the full tool-plane is unavailable
 *  and the caller must fall back (fail-open). */
export function getActiveMcpToolPlaneHost(): McpToolPlaneHost | null {
	return resolveGlobalSingleton<{ value: McpToolPlaneHost | null }>(HOST_KEY, () => ({ value: null })).value;
}
