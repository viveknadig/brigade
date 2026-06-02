/**
 * Heartbeat wake planner.
 *
 * Brand-scrubbed lift of upstream's `src/infra/heartbeat-wake.ts`. Provides
 * the wake-INTENT layer that sits in front of the heartbeat RUNNER
 * (Step 14). Producers (`requestHeartbeatNow(...)`) call into this
 * module; this module coalesces, priorities, schedules; eventually the
 * registered handler (the runner from Step 14) is invoked once per
 * coalesce window with one wake intent per target.
 *
 * Design choices preserved verbatim:
 *
 *   - **Singleton state** — one planner per JS realm (the wake state is
 *     process-wide). Backed by `resolveGlobalSingleton` so test resets
 *     can swap it cleanly.
 *
 *   - **Priority dedupe** — when two wake requests collide for the same
 *     `(agentId, sessionKey)` target inside the coalesce window, the
 *     higher-priority reason wins (RETRY=0 < INTERVAL=1 < DEFAULT=2 <
 *     ACTION=3). On equal priority, the newer timestamp wins. Replaces
 *     in place; never coalesces by *appending*.
 *
 *   - **Coalesce window** — 250ms default. New requests inside the
 *     window collapse into the pending entry. Sliding window: a later
 *     request can preempt an earlier-scheduled fire if its target's
 *     priority demands sooner attention.
 *
 *   - **Retry cooldown** — a 1-second floor between handler invocations
 *     when the runner reports `requests-in-flight`. The wake layer (NOT
 *     the runner) owns the retry — keeps the back-off centralized so
 *     no caller has to thread retry state.
 *
 *   - **Handler generation counter** — `setHeartbeatWakeHandler(null)`
 *     bumps a generation; any disposer from a prior handler is a no-op
 *     after the bump. Lets SIGUSR1 / config reload swap the handler
 *     cleanly without ghost calls.
 *
 * What this module does NOT do:
 *
 *   - It does NOT enqueue work onto `command-queue.ts` — that's the
 *     runner's job (Step 14).
 *   - It does NOT call any LLM — purely a scheduling primitive.
 *   - It does NOT inspect the session inbox — the runner peeks before
 *     deciding whether to fire a turn.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const log = createSubsystemLogger("agents/heartbeat-wake");

export type HeartbeatRunResult =
	| { status: "ran"; durationMs: number }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export type HeartbeatWakeOptions = {
	reason?: string;
	agentId?: string;
	sessionKey?: string;
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeOptions) => Promise<HeartbeatRunResult>;

type WakeTimerKind = "normal" | "retry";

type PendingWakeReason = {
	reason: string;
	priority: number;
	requestedAt: number;
	agentId?: string;
	sessionKey?: string;
};

type HeartbeatWakeState = {
	handler: HeartbeatWakeHandler | null;
	handlerGeneration: number;
	pendingWakes: Map<string, PendingWakeReason>;
	scheduled: boolean;
	running: boolean;
	timer: NodeJS.Timeout | null;
	timerDueAt: number | null;
	timerKind: WakeTimerKind | null;
	enabled: boolean;
};

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

const REASON_PRIORITY = {
	RETRY: 0,
	INTERVAL: 1,
	DEFAULT: 2,
	ACTION: 3,
} as const;

const HEARTBEAT_WAKE_STATE_KEY = Symbol.for("brigade.heartbeatWake.state");

function createState(): HeartbeatWakeState {
	return {
		handler: null,
		handlerGeneration: 0,
		pendingWakes: new Map(),
		scheduled: false,
		running: false,
		timer: null,
		timerDueAt: null,
		timerKind: null,
		enabled: true,
	};
}

function getState(): HeartbeatWakeState {
	return resolveGlobalSingleton<HeartbeatWakeState>(HEARTBEAT_WAKE_STATE_KEY, createState);
}

function normalizeWakeReason(value: string | undefined | null): string {
	const trimmed = (value ?? "").trim();
	return trimmed.length > 0 ? trimmed : "requested";
}

function normalizeWakeTarget(value: string | undefined | null): string | undefined {
	const trimmed = (value ?? "").trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveReasonPriority(reason: string): number {
	if (reason === "retry") return REASON_PRIORITY.RETRY;
	if (reason === "interval") return REASON_PRIORITY.INTERVAL;
	// Action-class reasons: explicit operator wakes, cron fires, exec events,
	// hook-driven triggers — anything where the user is actively expecting a
	// fast response.
	if (
		reason === "manual" ||
		reason === "exec-event" ||
		reason === "cron-event" ||
		reason.startsWith("cron:") ||
		reason.startsWith("hook:") ||
		reason === "wake"
	) {
		return REASON_PRIORITY.ACTION;
	}
	return REASON_PRIORITY.DEFAULT;
}

function getWakeTargetKey(params: { agentId?: string; sessionKey?: string }): string {
	const agentId = params.agentId ?? "";
	const sessionKey = params.sessionKey ?? "";
	return `${agentId}::${sessionKey}`;
}

function queuePendingWakeReason(params?: {
	reason?: string;
	requestedAt?: number;
	agentId?: string;
	sessionKey?: string;
}): void {
	const state = getState();
	const requestedAt = params?.requestedAt ?? Date.now();
	const normalizedReason = normalizeWakeReason(params?.reason);
	const normalizedAgentId = normalizeWakeTarget(params?.agentId);
	const normalizedSessionKey = normalizeWakeTarget(params?.sessionKey);
	const wakeTargetKey = getWakeTargetKey({
		agentId: normalizedAgentId,
		sessionKey: normalizedSessionKey,
	});
	const next: PendingWakeReason = {
		reason: normalizedReason,
		priority: resolveReasonPriority(normalizedReason),
		requestedAt,
		agentId: normalizedAgentId,
		sessionKey: normalizedSessionKey,
	};
	const previous = state.pendingWakes.get(wakeTargetKey);
	if (!previous) {
		state.pendingWakes.set(wakeTargetKey, next);
		return;
	}
	if (next.priority > previous.priority) {
		state.pendingWakes.set(wakeTargetKey, next);
		return;
	}
	if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
		state.pendingWakes.set(wakeTargetKey, next);
	}
	// Otherwise: keep the previous entry (lower-priority and equal-or-older
	// timestamp loses).
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal"): void {
	const state = getState();
	const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
	const dueAt = Date.now() + delay;
	if (state.timer) {
		// Retry cooldown is a hard minimum: never preempt it.
		if (state.timerKind === "retry") return;
		// Existing timer fires no later than the new request — keep it.
		if (typeof state.timerDueAt === "number" && state.timerDueAt <= dueAt) return;
		// New request fires sooner; preempt.
		clearTimeout(state.timer);
		state.timer = null;
		state.timerDueAt = null;
		state.timerKind = null;
	}
	state.timerDueAt = dueAt;
	state.timerKind = kind;
	state.timer = setTimeout(() => {
		void onTimerFire(delay, kind);
	}, delay);
	state.timer.unref?.();
}

async function onTimerFire(delay: number, kind: WakeTimerKind): Promise<void> {
	const state = getState();
	state.timer = null;
	state.timerDueAt = null;
	state.timerKind = null;
	state.scheduled = false;
	const active = state.handler;
	if (!active) return;
	if (state.running) {
		state.scheduled = true;
		schedule(delay, kind);
		return;
	}
	const pendingBatch = Array.from(state.pendingWakes.values());
	state.pendingWakes.clear();
	state.running = true;
	try {
		for (const pendingWake of pendingBatch) {
			const wakeOpts: HeartbeatWakeOptions = {
				reason: pendingWake.reason,
				...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
				...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
			};
			let res: HeartbeatRunResult;
			try {
				res = await active(wakeOpts);
			} catch (err) {
				log.error("heartbeat wake handler threw", {
					reason: pendingWake.reason,
					error: (err as Error)?.message,
				});
				queuePendingWakeReason({
					reason: "retry",
					agentId: pendingWake.agentId,
					sessionKey: pendingWake.sessionKey,
				});
				schedule(DEFAULT_RETRY_MS, "retry");
				continue;
			}
			if (res.status === "skipped" && res.reason === "requests-in-flight") {
				// Lane is busy; requeue + retry cooldown.
				queuePendingWakeReason({
					reason: "retry",
					agentId: pendingWake.agentId,
					sessionKey: pendingWake.sessionKey,
				});
				schedule(DEFAULT_RETRY_MS, "retry");
			}
		}
	} finally {
		state.running = false;
		if (state.pendingWakes.size > 0 || state.scheduled) {
			schedule(delay, "normal");
		}
	}
}

/**
 * Register the heartbeat handler. Returns a disposer that clears the
 * handler back to `null`. Calling `setHeartbeatWakeHandler(null)` (or
 * the disposer) bumps a generation counter so any in-flight tasks
 * stamped to the prior handler are dropped on completion.
 *
 * Replacing a non-null handler with a non-null handler clears stale
 * timers + running flag — useful for SIGUSR1 / config reload paths
 * that swap the runner mid-run.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
	const state = getState();
	state.handlerGeneration += 1;
	const generation = state.handlerGeneration;
	state.handler = next;
	if (next) {
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
		state.timerDueAt = null;
		state.timerKind = null;
		state.running = false;
		state.scheduled = false;
	}
	if (state.handler && state.pendingWakes.size > 0) {
		schedule(DEFAULT_COALESCE_MS, "normal");
	}
	return () => {
		const current = getState();
		if (current.handlerGeneration !== generation) return;
		if (current.handler !== next) return;
		current.handlerGeneration += 1;
		current.handler = null;
	};
}

export interface RequestHeartbeatOptions {
	reason?: string;
	coalesceMs?: number;
	agentId?: string;
	sessionKey?: string;
}

/**
 * Queue a wake intent for the next handler fire. Coalesce + priority
 * dedupe rules apply — see module doc.
 *
 * Returns nothing; failures (no handler registered) are silent — the
 * intent stays queued and fires whenever a handler is registered.
 */
export function requestHeartbeatNow(opts: RequestHeartbeatOptions = {}): void {
	queuePendingWakeReason({
		reason: opts.reason,
		agentId: opts.agentId,
		sessionKey: opts.sessionKey,
	});
	schedule(opts.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

/** True iff there is at least one pending wake or a scheduled timer. */
export function hasPendingHeartbeatWake(): boolean {
	const state = getState();
	return state.pendingWakes.size > 0 || Boolean(state.timer) || state.scheduled;
}

/**
 * Global enable/disable toggle. Brigade's heartbeat is on by default;
 * the runner reads this flag and short-circuits to "skipped: disabled"
 * when off. The toggle is in-memory only — set on boot from config,
 * not persisted here.
 */
export function setHeartbeatsEnabled(enabled: boolean): void {
	getState().enabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
	return getState().enabled;
}

/** Test-only — full reset (timers, pending, handler, enabled flag). */
export function resetHeartbeatWakeStateForTests(): void {
	const state = getState();
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
	state.timerDueAt = null;
	state.timerKind = null;
	state.pendingWakes.clear();
	state.scheduled = false;
	state.running = false;
	state.handlerGeneration += 1;
	state.handler = null;
	state.enabled = true;
}
