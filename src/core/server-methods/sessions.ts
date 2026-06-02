/**
 * Sessions-related gateway method handlers (Step 25).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/server-methods/sessions.ts`,
 * scoped to the four methods Brigade's sessions tool surface (Steps
 * 19-23) actually calls:
 *
 *   - `sessions.list`     → enumerate live sessions
 *   - `sessions.history`  → read JSONL transcript
 *   - `sessions.send`     → enqueue a message into a session's lane
 *   - `sessions.spawn`    → invoke Step 20's spawn engine
 *
 * Brigade scope notes:
 *
 *   - The handlers here are PURE — they take their params and return a
 *     result. The transport (WebSocket / in-process) is the
 *     `gateway-caller-impl.ts` layer's responsibility.
 *   - Param validation is light at this milestone (the protocol layer
 *     does the heavy AJV check before dispatch lands). Defensive coercion
 *     prevents wild input from crashing the handler.
 *   - `sessions.history` delegates to a `historyReader` dependency so
 *     tests can inject a stub and the live runtime can wire to the JSONL
 *     reader (Pi `SessionManager.readMessages` adapter).
 *   - `sessions.send` here is a THIN passthrough — it dispatches the
 *     inbound message into the target's lane and emits the lifecycle
 *     event. The actual LLM turn execution is owned by Step 25's
 *     `agent-dispatcher.ts`.
 */

import { dispatchAgentRun, type DispatchAgentRunDeps } from "../agent-dispatcher.js";
import {
	listLiveSessions,
	type LiveSessionRecord,
} from "../../agents/session-registry.js";
import { resolveAgentIdFromSessionKey } from "../../agents/routing/session-key.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { upsertSessionEntry } from "../../sessions/session-store.js";
import type {
	SessionsHistoryParams,
	SessionsHistoryResult,
	SessionsListParams,
	SessionsListResult,
	SessionsPatchParams,
	SessionsPatchResult,
	SessionsSendParams,
	SessionsSendResult,
	SessionsSpawnParams,
	SessionsSpawnResult,
	SessionListRow,
} from "../../protocol/methods.js";

/* ─── sessions.list ─────────────────────────────────────────────── */

export interface SessionsListHandlerDeps {
	/**
	 * Brigade's session-store lookup (Step 9). When supplied, the handler
	 * enriches each live row with persisted metadata (label, model,
	 * tokens, etc.). When omitted, only the in-memory registry view is
	 * returned.
	 */
	enrichRow?: (record: LiveSessionRecord) => SessionListRow;
}

export async function handleSessionsList(
	params: SessionsListParams = {},
	deps: SessionsListHandlerDeps = {},
): Promise<SessionsListResult> {
	const live = listLiveSessions();
	const filtered = applyFilters(live, params);
	const rows = filtered.map((entry) => buildRow(entry, deps));
	return { sessions: rows, count: rows.length };
}

function applyFilters(rows: LiveSessionRecord[], params: SessionsListParams): LiveSessionRecord[] {
	let filtered = rows;
	if (params.agentId) {
		filtered = filtered.filter((entry) => entry.agentId === params.agentId);
	}
	if (params.spawnedBy) {
		filtered = filtered.filter(
			(entry) =>
				typeof entry.metadata?.spawnedBy === "string" &&
				entry.metadata.spawnedBy === params.spawnedBy,
		);
	}
	if (typeof params.activeMinutes === "number" && params.activeMinutes > 0) {
		const cutoff = Date.now() - params.activeMinutes * 60 * 1_000;
		filtered = filtered.filter((entry) => entry.lastActivityAt >= cutoff);
	}
	if (typeof params.limit === "number" && params.limit > 0) {
		filtered = filtered.slice(0, params.limit);
	}
	return filtered;
}

function buildRow(entry: LiveSessionRecord, deps: SessionsListHandlerDeps): SessionListRow {
	if (deps.enrichRow) return deps.enrichRow(entry);
	return {
		sessionKey: entry.sessionKey,
		agentId: entry.agentId,
		state: entry.state,
		startedAt: entry.createdAt,
		updatedAt: entry.lastActivityAt,
	};
}

/* ─── sessions.history ──────────────────────────────────────────── */

export interface SessionsHistoryHandlerDeps {
	/** Mandatory reader — Brigade's runtime wires this to the JSONL adapter. */
	readMessages: (params: {
		sessionKey: string;
		limit?: number;
	}) => Promise<ReadonlyArray<unknown>>;
}

export async function handleSessionsHistory(
	params: SessionsHistoryParams,
	deps: SessionsHistoryHandlerDeps,
): Promise<SessionsHistoryResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { messages: [] };
	}
	const messages = await deps.readMessages({
		sessionKey,
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
	});
	return { messages: messages ?? [] };
}

/* ─── sessions.send ─────────────────────────────────────────────── */

export interface SessionsSendHandlerDeps extends DispatchAgentRunDeps {}

export async function handleSessionsSend(
	params: SessionsSendParams,
	deps: SessionsSendHandlerDeps,
): Promise<SessionsSendResult> {
	const run = dispatchAgentRun(
		{
			sessionKey: params.sessionKey,
			message: params.message,
			idempotencyKey: params.idempotencyKey,
			thinking: params.thinking,
			timeout: typeof params.timeoutMs === "number" ? params.timeoutMs / 1_000 : undefined,
			deliver: true,
		},
		deps,
	);
	// Caller pattern: respond immediately with runId; the lifecycle
	// event-bus emits the turn-end notification when `run.settled`
	// resolves. We DO NOT await `run.settled` here because that would
	// block the gateway response — the caller (or subscriber on the
	// lifecycle stream) picks up the final asynchronously.
	void run.settled.catch(() => undefined);
	return { ok: true, runId: run.runId };
}

/* ─── sessions.spawn ────────────────────────────────────────────── */

export interface SessionsSpawnHandlerDeps {
	/**
	 * Caller's current session depth, resolved from the session store.
	 * Brigade wires this from the persisted session entry; tests pass
	 * a constant.
	 */
	resolveCallerDepth?: (params: { sessionKey: string }) => number | Promise<number>;
}

/* ─── sessions.patch ────────────────────────────────────────────── */

/**
 * Handle the `sessions.patch` RPC. Looks up the agentId from the
 * session key, then upserts the patch into the per-agent session store
 * via `upsertSessionEntry`. Returns `{ok, created, sessionId}`.
 *
 * Brigade's existing per-agent session-store is the source of truth
 * here — the cross-agent registry from Step 9 is a parallel surface
 * scoped to the new `brigade-store.json`. The two stores serve
 * different consumers and never share entries.
 */
export async function handleSessionsPatch(
	params: SessionsPatchParams,
): Promise<SessionsPatchResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { ok: false, created: false };
	}
	const agentId = resolveAgentIdFromSessionKey(sessionKey);
	const patch = params.patch ?? {};
	// upsertSessionEntry reports `created=true` when the entry was minted.
	// To know whether the entry existed BEFORE, we'd need a pre-read;
	// today the handler approximates `created` by checking presence of
	// `lastUsedAt` in the result vs. `createdAt` (a fresh entry has them
	// equal). Brigade can refine if observers need stricter semantics.
	const beforeCreate = Date.now();
	const entry = upsertSessionEntry(agentId, sessionKey, patch);
	const created = new Date(entry.createdAt).getTime() >= beforeCreate - 1_000;
	return { ok: true, created, sessionId: entry.sessionId };
}

export async function handleSessionsSpawn(
	params: SessionsSpawnParams,
	deps: SessionsSpawnHandlerDeps = {},
): Promise<SessionsSpawnResult> {
	const callerDepth = deps.resolveCallerDepth
		? await deps.resolveCallerDepth({ sessionKey: params.parentSessionKey })
		: 0;
	const result = await spawnSubagentDirect(
		{
			task: params.task,
			label: params.label,
			agentId: params.agentId,
			model: params.model,
			thinking: params.thinking,
			runTimeoutSeconds: params.runTimeoutSeconds,
			thread: params.thread,
			mode: params.mode,
			cleanup: params.cleanup,
			sandbox: params.sandbox,
		},
		{
			agentSessionKey: params.parentSessionKey,
			callerDepth,
		},
	);
	if (result.status !== "accepted" || !result.childSessionKey || !result.runId) {
		throw new Error(result.error ?? "spawn failed");
	}
	return {
		runId: result.runId,
		childSessionKey: result.childSessionKey,
		mode: result.mode ?? "run",
	};
}
