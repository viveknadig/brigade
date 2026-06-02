/**
 * Backoff + cooldown primitives shared by the channel manager's restart
 * loop, the heartbeat-runner's wake-cooldown layer, and any other "try
 * again after N ms" pattern in the runtime.
 *
 * Two flavours of policy declared as readonly tuples:
 *   - `CHANNEL_RESTART_POLICY` — `[1s, 5s, 15s, 60s, 5min]` schedule applied
 *     by the channel-manager when a per-account `startAccount()` exits with
 *     a non-zero crash. After the 5th crash inside the cap window the
 *     account is parked and operator intervention is required.
 *
 * `computeBackoff(attemptIndex, schedule)` returns the next delay in ms.
 * `attemptIndex` is 0-based — first crash uses `schedule[0]`. Indexes past
 * the schedule end clamp to the final entry (so retry stays bounded at the
 * tail, not infinite).
 *
 * `sleepWithAbort(ms, signal)` is a plain abortable timer — resolves at
 * the deadline OR rejects with the signal's reason if the signal aborts
 * first. No try/catch boilerplate at call sites.
 */

export const CHANNEL_RESTART_POLICY = [1_000, 5_000, 15_000, 60_000, 5 * 60_000] as const;

export function computeBackoff(attemptIndex: number, schedule: readonly number[]): number {
	if (schedule.length === 0) return 0;
	if (attemptIndex < 0) return schedule[0]!;
	const last = schedule.length - 1;
	const i = Math.min(attemptIndex, last);
	return schedule[i]!;
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal!.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
