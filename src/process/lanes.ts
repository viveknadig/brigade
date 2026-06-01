/**
 * Command lanes — cooperative parallelism for the Brigade gateway.
 *
 * Before lanes, every gateway turn serialised through a single global
 * `turnChain` Promise in `server.ts`. A long-running channel turn from
 * one peer (WhatsApp DM A) would block a turn from another peer
 * (WhatsApp DM B), and the cron service's own work would either fight
 * for the same chain or run completely outside it (creating coordination
 * bugs). The single-chain shape is correct for "one operator's turns
 * never interleave" but wrong for "different peers can run in parallel"
 * and "the cron service shouldn't wait behind the operator's main turn".
 *
 * The lane model splits work into named lanes:
 *
 *   - `Main`      — the operator's primary turn lane. TUI / connect-mode
 *                   prompts + direct-RPC calls land here. Strictly FIFO.
 *   - `Cron`      — manual cron-fire work (operator clicking "run now").
 *                   Timer-driven fires bypass this lane and run directly
 *                   in their own per-instance lock — same shape as OC.
 *   - `Subagent`  — sub-agent spawns. Parent's `Main` lane keeps moving
 *                   while a sub-agent runs.
 *   - `Nested`    — sub-agents OF sub-agents, or work spawned from inside
 *                   a cron turn. Prevents nested deadlock when a Cron-lane
 *                   task tries to enqueue more Cron-lane work.
 *   - `session:<key>` — per-session lanes for channel-routed turns. Two
 *                   different DMs (WhatsApp A and WhatsApp B) get
 *                   different lanes and run concurrently. Inside a single
 *                   peer's lane work is still FIFO so messages 1, 2, 3
 *                   process in order.
 *
 * Same-lane tasks queue and run one at a time. Different-lane tasks
 * run concurrently. The lane is a string for extensibility — adding a
 * new well-known lane is a string-literal addition; per-session lanes
 * use `session:<sessionKey>` keys built on the fly.
 *
 * No worker pool, no max-concurrent budget per lane today (every lane
 * defaults to single-threaded). The OC reference uses
 * `maxConcurrent: 1` everywhere too; we'll add a knob if a future use
 * case needs it. The simpler shape is much easier to reason about than
 * a worker pool, and the perf win we needed (cross-lane parallelism)
 * is already there with FIFO chains.
 */

/** Well-known lane ids. String-literal so extensibility is cheap. */
export const CommandLane = {
	Main: "main",
	Cron: "cron",
	Subagent: "subagent",
	Nested: "nested",
} as const;
export type CommandLaneId = (typeof CommandLane)[keyof typeof CommandLane] | string;

/** Per-lane FIFO chain. Tail is the most-recently-enqueued promise. */
interface LaneState {
	tail: Promise<unknown>;
	/** In-flight count — diagnostic only; `getLaneQueueSize` reads this. */
	pending: number;
}

const lanes = new Map<string, LaneState>();

/**
 * Compute the per-session lane id for a session key. Channel-routed turns
 * pass `session:<sessionKey>` so each peer gets its own FIFO queue;
 * different peers run concurrently.
 */
export function sessionLane(sessionKey: string): string {
	return `session:${sessionKey}`;
}

/**
 * Run `work` on the named lane. Resolves with the work's result. If the
 * previous work on this lane rejected, this work still runs — the chain
 * never poisons because we catch the previous tail's rejection.
 *
 * Concurrency:
 *   - Two `enqueueInLane(lane, ...)` calls on the SAME lane: the second
 *     awaits the first.
 *   - Two calls on DIFFERENT lanes: run concurrently.
 *
 * Idempotence:
 *   - Each call gets its own lane state allocated lazily on first use.
 *   - The lane's tail advances atomically with synchronous map writes.
 */
export function enqueueInLane<T>(
	lane: CommandLaneId,
	work: () => Promise<T>,
): Promise<T> {
	const state = lanes.get(lane) ?? { tail: Promise.resolve(), pending: 0 };
	const previous = state.tail.catch(() => undefined);
	state.pending += 1;
	const next = previous.then(() => work());
	state.tail = next.catch(() => undefined);
	lanes.set(lane, state);
	// Decrement the pending counter when this work settles — whichever way.
	const settle = (): void => {
		const s = lanes.get(lane);
		if (s) s.pending = Math.max(0, s.pending - 1);
	};
	next.then(settle, settle);
	return next;
}

/**
 * How many tasks are queued or in-flight on this lane. Used by the
 * heartbeat to decide whether to fire a drain turn — if Main has
 * pending work, skip the heartbeat and let it run naturally.
 */
export function getLaneQueueSize(lane: CommandLaneId): number {
	return lanes.get(lane)?.pending ?? 0;
}

/** Diagnostic — every lane that's seen at least one task. */
export function listKnownLanes(): readonly string[] {
	return [...lanes.keys()];
}

/** Test-only — clear every lane state. */
export function resetLanesForTests(): void {
	lanes.clear();
}
