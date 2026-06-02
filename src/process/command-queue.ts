/**
 * Generation-aware lane engine.
 *
 * Brand-scrubbed lift of the upstream reference codebase's
 * `src/process/command-queue.ts`. The engine is the load-bearing
 * primitive behind every lane Brigade serialises through — main agent
 * turns, cron fires, sub-agent spawns, per-session channel inbounds.
 *
 * What the engine adds over Brigade's previous in-module
 * `enqueueInLane`:
 *
 *   - **Generation counter per lane.** `resetAllLanes()` bumps each lane's
 *     generation; any in-flight task whose completion fires after the
 *     reset is ignored (it no longer mutates the lane's active-task
 *     set, doesn't trigger pump, doesn't notify drain waiters). This
 *     matters for in-process restart flows (SIGUSR1) where interrupted
 *     tasks' finally blocks may never run — without the counter, stale
 *     active-task IDs would permanently block new work.
 *
 *   - **maxConcurrent per lane.** Default 1 (FIFO behaviour matches the
 *     simpler module-state implementation). Channel-manager-fan-out lanes
 *     bump this per-account if/when concurrent multi-account inbound
 *     processing is enabled.
 *
 *   - **Gateway draining flag.** `markGatewayDraining()` flips a process-
 *     wide bit; subsequent enqueues reject immediately with
 *     `GatewayDrainingError`. Used during graceful shutdown so the
 *     listener doesn't accept new work that would be killed mid-flight.
 *
 *   - **Drain helpers.** `waitForActiveTasks(timeoutMs)` resolves once
 *     all currently-active tasks finish (or the timeout elapses) — used
 *     by the shutdown path + by tests that need a hard sync point.
 *
 *   - **Global-singleton-backed state.** Lanes, draining flag, and the
 *     active-task waiters all live in a `Symbol.for("brigade.commandQueueState")`
 *     slot on `globalThis`. Survives hot-reload + module-cache
 *     duplication (in tests / in dev with watch mode).
 *
 * Brand-scrubs applied:
 *   - Global-singleton Symbol key namespaced to `brigade.commandQueueState`
 *   - The upstream `isExpectedNonErrorLaneFailure` check for
 *     `LiveSessionModelSwitchError` is dropped (Brigade has no in-flight
 *     model-switch flow — every lane error is treated as a real error
 *     per R2 Leak #5 of the locked design).
 *   - `diagnosticLogger` / `logLaneDequeue` / `logLaneEnqueue` →
 *     `createSubsystemLogger("lanes")` (Brigade-native logger; the
 *     dev-only per-event trace pings are dropped, the warn/error/debug
 *     equivalents stay).
 *
 * Public surface (consumed by `process/lanes.ts` + the gateway):
 *   - `CommandLaneClearedError`, `GatewayDrainingError`
 *   - `enqueueCommandInLane<T>(lane, task, opts?) : Promise<T>`
 *   - `enqueueCommand<T>(task, opts?) : Promise<T>`  (Main-lane sugar)
 *   - `setCommandLaneConcurrency(lane, max)`
 *   - `clearCommandLane(lane?)`
 *   - `markGatewayDraining()`
 *   - `getQueueSize(lane?)`, `getTotalQueueSize()`, `getActiveTaskCount()`
 *   - `waitForActiveTasks(timeoutMs) : Promise<{drained}>`
 *   - `resetAllLanes()`
 *   - `resetCommandQueueStateForTest()` — test-only hard reset
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CommandLane } from "./lanes.js";

const log = createSubsystemLogger("lanes");

/**
 * Thrown when a queued task is rejected because its lane was cleared
 * (either explicitly via `clearCommandLane` or as part of a test reset).
 * Callers that fire-and-forget enqueued tasks can catch this specific
 * type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
	constructor(lane?: string) {
		super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
		this.name = "CommandLaneClearedError";
	}
}

/**
 * Thrown when a new command is rejected because the gateway is currently
 * draining for restart. Distinguished from a regular task failure so
 * shutdown handlers don't log it as an error.
 */
export class GatewayDrainingError extends Error {
	constructor() {
		super("Gateway is draining for restart; new tasks are not accepted");
		this.name = "GatewayDrainingError";
	}
}

type QueueEntry = {
	task: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	enqueuedAt: number;
	warnAfterMs: number;
	onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
	lane: string;
	queue: QueueEntry[];
	activeTaskIds: Set<number>;
	maxConcurrent: number;
	draining: boolean;
	generation: number;
};

type ActiveTaskWaiter = {
	activeTaskIds: Set<number>;
	resolve: (value: { drained: boolean }) => void;
	timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk
 * shares the same lanes, counters, and draining flag in production
 * builds + survives hot-reload in dev.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("brigade.commandQueueState");

interface QueueState {
	gatewayDraining: boolean;
	lanes: Map<string, LaneState>;
	activeTaskWaiters: Set<ActiveTaskWaiter>;
	nextTaskId: number;
}

function getQueueState(): QueueState {
	const state = resolveGlobalSingleton<QueueState>(COMMAND_QUEUE_STATE_KEY, () => ({
		gatewayDraining: false,
		lanes: new Map<string, LaneState>(),
		activeTaskWaiters: new Set<ActiveTaskWaiter>(),
		nextTaskId: 1,
	}));
	// Schema migration: the singleton may have been created by an older
	// code version that did not include `activeTaskWaiters`. After an
	// in-process restart the new code inherits the stale object via the
	// global-singleton because the Symbol key already exists. Patch the
	// missing field so all downstream consumers see a valid Set instead
	// of `undefined`.
	if (!state.activeTaskWaiters) {
		state.activeTaskWaiters = new Set<ActiveTaskWaiter>();
	}
	return state;
}

function normalizeLane(lane: string): string {
	return lane.trim() || CommandLane.Main;
}

function getLaneDepth(state: LaneState): number {
	return state.queue.length + state.activeTaskIds.size;
}

function getLaneState(lane: string): LaneState {
	const queueState = getQueueState();
	const existing = queueState.lanes.get(lane);
	if (existing) {
		return existing;
	}
	const created: LaneState = {
		lane,
		queue: [],
		activeTaskIds: new Set(),
		maxConcurrent: 1,
		draining: false,
		generation: 0,
	};
	queueState.lanes.set(lane, created);
	return created;
}

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
	if (taskGeneration !== state.generation) {
		return false;
	}
	state.activeTaskIds.delete(taskId);
	return true;
}

function hasPendingActiveTasks(taskIds: Set<number>): boolean {
	const queueState = getQueueState();
	for (const state of queueState.lanes.values()) {
		for (const taskId of state.activeTaskIds) {
			if (taskIds.has(taskId)) {
				return true;
			}
		}
	}
	return false;
}

function resolveActiveTaskWaiter(waiter: ActiveTaskWaiter, result: { drained: boolean }): void {
	const queueState = getQueueState();
	if (!queueState.activeTaskWaiters.delete(waiter)) {
		return;
	}
	if (waiter.timeout) {
		clearTimeout(waiter.timeout);
	}
	waiter.resolve(result);
}

function notifyActiveTaskWaiters(): void {
	const queueState = getQueueState();
	for (const waiter of Array.from(queueState.activeTaskWaiters)) {
		if (waiter.activeTaskIds.size === 0 || !hasPendingActiveTasks(waiter.activeTaskIds)) {
			resolveActiveTaskWaiter(waiter, { drained: true });
		}
	}
}

function drainLane(lane: string): void {
	const state = getLaneState(lane);
	if (state.draining) {
		if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
			log.warn("drainLane blocked", {
				lane,
				draining: true,
				active: 0,
				queue: state.queue.length,
			});
		}
		return;
	}
	state.draining = true;

	const pump = (): void => {
		try {
			while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
				const entry = state.queue.shift() as QueueEntry;
				const waitedMs = Date.now() - entry.enqueuedAt;
				if (waitedMs >= entry.warnAfterMs) {
					try {
						entry.onWait?.(waitedMs, state.queue.length);
					} catch (err) {
						log.error("lane onWait callback failed", {
							lane,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					log.warn("lane wait exceeded", {
						lane,
						waitedMs,
						queueAhead: state.queue.length,
					});
				}
				const taskId = getQueueState().nextTaskId++;
				const taskGeneration = state.generation;
				state.activeTaskIds.add(taskId);
				void (async () => {
					const startTime = Date.now();
					try {
						const result = await entry.task();
						const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
						if (completedCurrentGeneration) {
							notifyActiveTaskWaiters();
							pump();
						}
						entry.resolve(result);
					} catch (err) {
						const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
						const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
						if (!isProbeLane) {
							log.error("lane task error", {
								lane,
								durationMs: Date.now() - startTime,
								error: err instanceof Error ? err.message : String(err),
							});
						}
						if (completedCurrentGeneration) {
							notifyActiveTaskWaiters();
							pump();
						}
						entry.reject(err);
					}
				})();
			}
		} finally {
			state.draining = false;
		}
	};

	pump();
}

/**
 * Mark gateway as draining for restart. Subsequent `enqueueCommandInLane`
 * calls reject immediately with `GatewayDrainingError` instead of being
 * silently killed on shutdown.
 */
export function markGatewayDraining(): void {
	getQueueState().gatewayDraining = true;
}

/**
 * Set the max-concurrent budget for a lane. Default is 1 (strict FIFO).
 * Bumping this allows that lane to run multiple tasks in parallel.
 * Pumping kicks in immediately if the queue has room.
 */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
	const cleaned = normalizeLane(lane);
	const state = getLaneState(cleaned);
	state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
	drainLane(cleaned);
}

/**
 * Enqueue a task on a named lane. Returns a promise that resolves with
 * the task's result (or rejects with the task's error / a
 * `GatewayDrainingError` / a `CommandLaneClearedError`).
 *
 * `opts.warnAfterMs` (default 2_000) — emit a warn log + optional
 *   `onWait` callback when the task has been queued longer than this.
 *   Useful for spotting lane congestion in production.
 */
export function enqueueCommandInLane<T>(
	lane: string,
	task: () => Promise<T>,
	opts?: {
		warnAfterMs?: number;
		onWait?: (waitMs: number, queuedAhead: number) => void;
	},
): Promise<T> {
	const queueState = getQueueState();
	if (queueState.gatewayDraining) {
		return Promise.reject(new GatewayDrainingError());
	}
	const cleaned = normalizeLane(lane);
	const warnAfterMs = opts?.warnAfterMs ?? 2_000;
	const state = getLaneState(cleaned);
	return new Promise<T>((resolve, reject) => {
		state.queue.push({
			task: () => task(),
			resolve: (value) => resolve(value as T),
			reject,
			enqueuedAt: Date.now(),
			warnAfterMs,
			onWait: opts?.onWait,
		});
		drainLane(cleaned);
	});
}

/** Main-lane sugar — `enqueueCommandInLane(CommandLane.Main, task, opts)`. */
export function enqueueCommand<T>(
	task: () => Promise<T>,
	opts?: {
		warnAfterMs?: number;
		onWait?: (waitMs: number, queuedAhead: number) => void;
	},
): Promise<T> {
	return enqueueCommandInLane(CommandLane.Main, task, opts);
}

/** Combined depth (queued + active) for one lane. 0 when the lane has never been used. */
export function getQueueSize(lane: string = CommandLane.Main): number {
	const resolved = normalizeLane(lane);
	const state = getQueueState().lanes.get(resolved);
	if (!state) {
		return 0;
	}
	return getLaneDepth(state);
}

/** Combined depth across every known lane. */
export function getTotalQueueSize(): number {
	let total = 0;
	for (const s of getQueueState().lanes.values()) {
		total += getLaneDepth(s);
	}
	return total;
}

/**
 * Reject every queued (not yet active) entry on a lane with
 * `CommandLaneClearedError`. Returns the number of entries removed.
 * Active tasks keep running — only the unstarted queue is purged.
 */
export function clearCommandLane(lane: string = CommandLane.Main): number {
	const cleaned = normalizeLane(lane);
	const state = getQueueState().lanes.get(cleaned);
	if (!state) {
		return 0;
	}
	const removed = state.queue.length;
	const pending = state.queue.splice(0);
	for (const entry of pending) {
		entry.reject(new CommandLaneClearedError(cleaned));
	}
	return removed;
}

/**
 * Test-only hard reset that discards ALL queue state, including queued
 * work from previous generations. Use when a suite needs an isolated
 * baseline across shared-worker runs.
 */
export function resetCommandQueueStateForTest(): void {
	const queueState = getQueueState();
	queueState.gatewayDraining = false;
	queueState.lanes.clear();
	for (const waiter of Array.from(queueState.activeTaskWaiters)) {
		resolveActiveTaskWaiter(waiter, { drained: true });
	}
	queueState.nextTaskId = 1;
}

/**
 * Reset every lane's runtime state to idle. Used after in-process
 * restarts (e.g. config reload) where interrupted tasks' finally blocks
 * may not run, leaving stale active-task IDs that would permanently
 * block new work.
 *
 * Bumps each lane's generation counter and clears the active-task set
 * so stale completions from old in-flight tasks are ignored. Queued
 * entries are intentionally PRESERVED — they represent pending operator
 * work that should still execute after the restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call.
 */
export function resetAllLanes(): void {
	const queueState = getQueueState();
	queueState.gatewayDraining = false;
	const lanesToDrain: string[] = [];
	for (const state of queueState.lanes.values()) {
		state.generation += 1;
		state.activeTaskIds.clear();
		state.draining = false;
		if (state.queue.length > 0) {
			lanesToDrain.push(state.lane);
		}
	}
	for (const lane of lanesToDrain) {
		drainLane(lane);
	}
	notifyActiveTaskWaiters();
}

/** Total of `activeTaskIds.size` across every lane (excludes queued). */
export function getActiveTaskCount(): number {
	const queueState = getQueueState();
	let total = 0;
	for (const s of queueState.lanes.values()) {
		total += s.activeTaskIds.size;
	}
	return total;
}

/**
 * Wait until every currently-active task across every lane has finished.
 * Resolves with `{drained: true}` when all done, `{drained: false}` if
 * the `timeoutMs` elapses first. New tasks enqueued AFTER this call are
 * ignored — only tasks already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
	const queueState = getQueueState();
	const activeAtStart = new Set<number>();
	for (const state of queueState.lanes.values()) {
		for (const taskId of state.activeTaskIds) {
			activeAtStart.add(taskId);
		}
	}

	if (activeAtStart.size === 0) {
		return Promise.resolve({ drained: true });
	}
	if (timeoutMs <= 0) {
		return Promise.resolve({ drained: false });
	}

	return new Promise((resolve) => {
		const waiter: ActiveTaskWaiter = {
			activeTaskIds: activeAtStart,
			resolve,
		};
		waiter.timeout = setTimeout(() => {
			resolveActiveTaskWaiter(waiter, { drained: false });
		}, timeoutMs);
		queueState.activeTaskWaiters.add(waiter);
		notifyActiveTaskWaiters();
	});
}
