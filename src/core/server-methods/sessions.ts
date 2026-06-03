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
import { readSessionStore, upsertSessionEntry } from "../../sessions/session-store.js";

/**
 * Wave O0.5: server-side access guard.
 *
 * Each handler accepts an optional `accessCheck` dep. The gateway boot path
 * wires a closure that resolves the requester's session key from the
 * per-connection auth context + the current visibility/A2A policy, then
 * defers to `checkSessionToolAccess` (the same helper the tool surface uses).
 *
 * Handlers that receive `accessCheck === undefined` execute as before —
 * meaningful for legacy in-process callers (boot wiring, test fixtures)
 * that have already proven trust. WebSocket RPC always wires a guard.
 */
export type SessionsHandlerAccessAction =
	| "list"
	| "history"
	| "send"
	| "spawn"
	| "abort"
	| "steer"
	| "agent"
	| "patch";

export interface SessionsHandlerAccessCheck {
	(params: {
		action: SessionsHandlerAccessAction;
		targetSessionKey: string;
	}): { allowed: boolean; reason?: string };
}

/**
 * Typed error thrown when the access guard refuses a gateway-side call.
 * The WebSocket dispatcher reads `code` and maps it to a typed RPC error
 * envelope (instead of the generic `internal` bucket), and in-process
 * callers can catch on `name === "SessionsAccessForbiddenError"`.
 */
export class SessionsAccessForbiddenError extends Error {
	readonly code = "forbidden";
	constructor(reason: string) {
		super(reason);
		this.name = "SessionsAccessForbiddenError";
	}
}

function enforceAccess(
	check: SessionsHandlerAccessCheck | undefined,
	action: SessionsHandlerAccessAction,
	targetSessionKey: string,
): void {
	if (!check) return;
	const verdict = check({ action, targetSessionKey });
	if (verdict.allowed) return;
	throw new SessionsAccessForbiddenError(
		verdict.reason ?? `sessions.${action} forbidden`,
	);
}
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
	/**
	 * Wave O0.5 access guard. When set, every candidate row is checked
	 * before inclusion; refused rows are dropped (NOT an error — list is
	 * filter-shaped). Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsList(
	params: SessionsListParams = {},
	deps: SessionsListHandlerDeps = {},
): Promise<SessionsListResult> {
	const live = listLiveSessions();
	const filtered = applyFilters(live, params);
	const visible = deps.accessCheck
		? filtered.filter((entry) => {
				const verdict = deps.accessCheck!({
					action: "list",
					targetSessionKey: entry.sessionKey,
				});
				return verdict.allowed;
			})
		: filtered;
	const rows = visible.map((entry) => buildRow(entry, deps));
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
	const base: SessionListRow = deps.enrichRow
		? deps.enrichRow(entry)
		: {
				sessionKey: entry.sessionKey,
				agentId: entry.agentId,
				state: entry.state,
				startedAt: entry.createdAt,
				updatedAt: entry.lastActivityAt,
			};
	// Wave O0.7 - surface spawn lineage from the persisted session store
	// so a `sessions_list` caller can see parent/depth without a separate
	// metadata RPC. Read is best-effort; on any IO error we fall back to
	// the live-registry metadata (`spawnedBy` set on dispatch).
	if (!base.spawnedBy || base.spawnDepth === undefined) {
		try {
			const agentId = entry.agentId;
			if (agentId) {
				const store = readSessionStore(agentId);
				const persisted = store.sessions[entry.sessionKey];
				if (persisted?.subagent) {
					if (!base.spawnedBy && persisted.subagent.spawnedBy) {
						base.spawnedBy = persisted.subagent.spawnedBy;
					}
					if (base.spawnDepth === undefined && typeof persisted.subagent.spawnDepth === "number") {
						base.spawnDepth = persisted.subagent.spawnDepth;
					}
					if (!base.label && persisted.subagent.label) {
						base.label = persisted.subagent.label;
					}
				}
			}
		} catch {
			// best-effort enrichment; lineage absent is non-fatal
		}
	}
	// Also fall back to the live-registry metadata (set at dispatch time)
	// for the parent key when the store-side metadata is absent.
	if (!base.spawnedBy && typeof entry.metadata?.spawnedBy === "string") {
		base.spawnedBy = entry.metadata.spawnedBy;
	}
	return base;
}

/* ─── sessions.history ──────────────────────────────────────────── */

export interface SessionsHistoryHandlerDeps {
	/** Mandatory reader — Brigade's runtime wires this to the JSONL adapter. */
	readMessages: (params: {
		sessionKey: string;
		limit?: number;
	}) => Promise<ReadonlyArray<unknown>>;
	/**
	 * Wave O0.5 access guard. Refused calls throw
	 * `SessionsAccessForbiddenError` which the RPC layer maps to a typed
	 * `forbidden` response. Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsHistory(
	params: SessionsHistoryParams,
	deps: SessionsHistoryHandlerDeps,
): Promise<SessionsHistoryResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { messages: [] };
	}
	enforceAccess(deps.accessCheck, "history", sessionKey);
	const messages = await deps.readMessages({
		sessionKey,
		...(typeof params.limit === "number" ? { limit: params.limit } : {}),
	});
	return { messages: messages ?? [] };
}

/* ─── sessions.send ─────────────────────────────────────────────── */

export interface SessionsSendHandlerDeps extends DispatchAgentRunDeps {
	/**
	 * Wave O0.5 access guard. Refused calls throw
	 * `SessionsAccessForbiddenError`. Omitted by trusted in-process callers.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsSend(
	params: SessionsSendParams,
	deps: SessionsSendHandlerDeps,
): Promise<SessionsSendResult> {
	enforceAccess(deps.accessCheck, "send", params.sessionKey);
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
	/**
	 * Wave O0.5 access guard. Spawn is checked against the
	 * `parentSessionKey` because the child key is minted by the engine.
	 */
	accessCheck?: SessionsHandlerAccessCheck;
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
export interface SessionsPatchHandlerDeps {
	/** Wave O0.5 access guard — refused calls throw. */
	accessCheck?: SessionsHandlerAccessCheck;
}

export async function handleSessionsPatch(
	params: SessionsPatchParams,
	deps: SessionsPatchHandlerDeps = {},
): Promise<SessionsPatchResult> {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey) {
		return { ok: false, created: false };
	}
	enforceAccess(deps.accessCheck, "patch", sessionKey);
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
	enforceAccess(deps.accessCheck, "spawn", params.parentSessionKey);
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
