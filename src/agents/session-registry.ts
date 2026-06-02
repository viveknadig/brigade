/**
 * In-process live-session registry.
 *
 * Tracks the sessions Brigade's gateway is actively running a turn for —
 * the orthogonal counterpart to `session-store.ts` (which persists per-
 * session metadata to disk) and `subagent-registry.ts` (which tracks
 * sub-agent runs spawned BY sessions).
 *
 * Why have a separate live registry at all (upstream doesn't): the upstream
 * codebase distributes "is this session currently running?" across a
 * subagent-runs Map + a session-store + ad-hoc Promise refs in the
 * dispatcher. Brigade folds that into one explicit Map so the heartbeat
 * runner (Step 14), the channel manager (Step 16), the approval router
 * (Step 17), and the gateway dispatcher (Step 25) all have ONE place to
 * ask "is X live?" — and ONE place to abort it on graceful shutdown.
 *
 * Backing store: a `resolveGlobalSingleton`-pinned Map keyed by
 * canonical session key (`agent:<id>:...`). Lives for the process
 * lifetime; never persisted. A fresh process boots with an empty Map.
 *
 * Hook surface:
 *   - `onStateChange(listener)` for observers (Step 18 agent-events fan-out).
 *   - Abort propagation: each entry carries the turn's `AbortController`,
 *     so a graceful shutdown can call `abortAllSessions("shutdown")`
 *     and every in-flight turn unwinds promptly.
 *
 * Reentrancy: re-registering a sessionKey replaces the prior entry (with
 * a debug log). The dispatcher should always `unregister` before
 * `register`-ing the same key; the replacement is a safety net for
 * crash-recovery races, not a primary path.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const log = createSubsystemLogger("agents/session-registry");

export type SessionLifecycleState = "running" | "idle" | "draining" | "terminated";

export type LiveSessionRecord = {
	sessionKey: string;
	sessionId: string;
	agentId: string;
	runId: string;
	lane: string;
	state: SessionLifecycleState;
	createdAt: number;
	lastStateChangeAt: number;
	lastActivityAt: number;
	abortController?: AbortController;
	/** Free-form per-session metadata. Never persisted. */
	metadata?: Record<string, unknown>;
};

export type SessionStateChangeEvent = {
	sessionKey: string;
	previousState: SessionLifecycleState | "registered";
	newState: SessionLifecycleState;
	timestamp: number;
};

type SessionStateListener = (event: SessionStateChangeEvent) => void;

type SessionRegistryState = {
	sessions: Map<string, LiveSessionRecord>;
	listeners: Set<SessionStateListener>;
};

const SESSION_REGISTRY_STATE_KEY = Symbol.for("brigade.sessionRegistry.state");

function createState(): SessionRegistryState {
	return { sessions: new Map(), listeners: new Set() };
}

function getState(): SessionRegistryState {
	return resolveGlobalSingleton<SessionRegistryState>(SESSION_REGISTRY_STATE_KEY, createState);
}

function emit(event: SessionStateChangeEvent): void {
	const { listeners } = getState();
	for (const listener of listeners) {
		try {
			listener(event);
		} catch (err) {
			log.warn("session-state listener threw", {
				sessionKey: event.sessionKey,
				error: (err as Error)?.message,
			});
		}
	}
}

export interface RegisterSessionParams {
	sessionKey: string;
	sessionId: string;
	agentId: string;
	runId: string;
	lane: string;
	abortController?: AbortController;
	metadata?: Record<string, unknown>;
}

/**
 * Register a fresh live session. If `sessionKey` is already registered,
 * the existing entry is replaced (logged) — the dispatcher should have
 * `unregister`-ed first; replacement is a crash-recovery safety net.
 */
export function registerLiveSession(params: RegisterSessionParams): LiveSessionRecord {
	const state = getState();
	const now = Date.now();
	if (state.sessions.has(params.sessionKey)) {
		log.debug("replacing existing live-session entry", { sessionKey: params.sessionKey });
	}
	const record: LiveSessionRecord = {
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		agentId: params.agentId,
		runId: params.runId,
		lane: params.lane,
		state: "running",
		createdAt: now,
		lastStateChangeAt: now,
		lastActivityAt: now,
		abortController: params.abortController,
		metadata: params.metadata,
	};
	state.sessions.set(params.sessionKey, record);
	emit({
		sessionKey: params.sessionKey,
		previousState: "registered",
		newState: "running",
		timestamp: now,
	});
	return record;
}

/** Lookup by canonical session key. */
export function getLiveSession(sessionKey: string): LiveSessionRecord | undefined {
	if (!sessionKey) return undefined;
	return getState().sessions.get(sessionKey);
}

/** `true` while the session is registered in any non-terminated state. */
export function hasLiveSession(sessionKey: string): boolean {
	const entry = getLiveSession(sessionKey);
	return Boolean(entry && entry.state !== "terminated");
}

/** Snapshot every currently registered session. */
export function listLiveSessions(): LiveSessionRecord[] {
	return [...getState().sessions.values()];
}

/**
 * Filter to sessions matching a predicate. Common shapes:
 *   - by agent: `listLiveSessionsWhere((s) => s.agentId === "main")`
 *   - by lane:  `listLiveSessionsWhere((s) => s.lane.startsWith("session:"))`
 */
export function listLiveSessionsWhere(
	predicate: (entry: LiveSessionRecord) => boolean,
): LiveSessionRecord[] {
	return listLiveSessions().filter(predicate);
}

/** Count of currently-running (non-idle, non-draining, non-terminated) sessions. */
export function countActiveLiveSessions(): number {
	let n = 0;
	for (const entry of getState().sessions.values()) {
		if (entry.state === "running") n += 1;
	}
	return n;
}

function transitionState(sessionKey: string, newState: SessionLifecycleState): boolean {
	const state = getState();
	const entry = state.sessions.get(sessionKey);
	if (!entry) return false;
	if (entry.state === newState) return false;
	const previousState = entry.state;
	const now = Date.now();
	entry.state = newState;
	entry.lastStateChangeAt = now;
	entry.lastActivityAt = now;
	emit({ sessionKey, previousState, newState, timestamp: now });
	return true;
}

/** Mark a session idle (waiting on inbound) without unregistering. */
export function markSessionIdle(sessionKey: string): boolean {
	return transitionState(sessionKey, "idle");
}

/** Move a session into draining state (stop accepting new work, finish active). */
export function markSessionDraining(sessionKey: string): boolean {
	return transitionState(sessionKey, "draining");
}

/** Mark a session running again after an idle/draining pause. */
export function markSessionRunning(sessionKey: string): boolean {
	return transitionState(sessionKey, "running");
}

/** Touch `lastActivityAt` without changing state. Used by heartbeat + inbound dispatch. */
export function touchSessionActivity(sessionKey: string): boolean {
	const entry = getLiveSession(sessionKey);
	if (!entry) return false;
	entry.lastActivityAt = Date.now();
	return true;
}

/**
 * Abort a session's in-flight turn (if it holds an abort controller) and
 * mark it terminated. Returns `true` if the entry was found.
 */
export function abortLiveSession(sessionKey: string, reason?: string): boolean {
	const state = getState();
	const entry = state.sessions.get(sessionKey);
	if (!entry) return false;
	try {
		entry.abortController?.abort(reason ?? "session-aborted");
	} catch (err) {
		log.warn("abortController threw on abort()", {
			sessionKey,
			error: (err as Error)?.message,
		});
	}
	transitionState(sessionKey, "terminated");
	return true;
}

/**
 * Remove a session from the registry. Does NOT call `abort()` — the caller
 * is expected to have completed the turn (or to call `abortLiveSession`
 * first). Returns `true` if the entry was present.
 */
export function unregisterLiveSession(sessionKey: string): boolean {
	const state = getState();
	const entry = state.sessions.get(sessionKey);
	if (!entry) return false;
	const previousState = entry.state;
	state.sessions.delete(sessionKey);
	emit({
		sessionKey,
		previousState,
		newState: "terminated",
		timestamp: Date.now(),
	});
	return true;
}

/**
 * Graceful shutdown: abort every session's turn + transition them all to
 * `terminated`. Returns the count of sessions that received an abort.
 * Doesn't unregister — entries linger until explicit `unregisterLiveSession`
 * or `resetSessionRegistryForTests`.
 */
export function abortAllSessions(reason?: string): number {
	const state = getState();
	let n = 0;
	for (const entry of state.sessions.values()) {
		if (entry.state === "terminated") continue;
		try {
			entry.abortController?.abort(reason ?? "shutdown");
		} catch {
			// best-effort
		}
		const previous = entry.state;
		entry.state = "terminated";
		entry.lastStateChangeAt = Date.now();
		emit({
			sessionKey: entry.sessionKey,
			previousState: previous,
			newState: "terminated",
			timestamp: Date.now(),
		});
		n += 1;
	}
	return n;
}

/**
 * Subscribe to lifecycle transitions. Returns a disposer that removes the
 * listener. Listener exceptions are logged + swallowed (a misbehaving
 * subscriber must not crash the dispatcher).
 */
export function onSessionStateChange(listener: SessionStateListener): () => void {
	const state = getState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

/** Test-only — drop every entry + every listener. */
export function resetSessionRegistryForTests(): void {
	const state = getState();
	state.sessions.clear();
	state.listeners.clear();
}
