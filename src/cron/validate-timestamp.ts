/**
 * Validator for `kind: "at"` schedule timestamps.
 *
 * Why this exists: the model parses operator-language times like
 * "12:27 AM IST" → epoch ms. If it lands on "today 12:27" while the
 * current wall-clock is 12:27 PM, the resulting epoch is in the past or
 * within the current minute. `schedule.ts` then either returns undefined
 * for `computeNextRunAtMs` (job never fires) OR — if the model adds a
 * 30s nudge — fires immediately, losing the operator's TOMORROW intent.
 *
 * This validator hard-rejects timestamps that are at-or-before `nowMs`
 * AND timestamps that are within the next 5 seconds (the no-fire grace
 * window). The error message is shaped to nudge the model toward the
 * correct interpretation when it retries.
 */

/** Minimum lead-time before an `at` job's fire-time. Defaults to 5 seconds. */
export const AT_MIN_LEAD_MS = 5_000;

export interface AssertFutureAtTimestampOptions {
	/**
	 * Required lead-time before the target. Defaults to `AT_MIN_LEAD_MS`. A
	 * caller can shrink it for tests but should never bypass the grace
	 * window entirely — "fire right now" is almost always wrong for a
	 * cron-style scheduled task.
	 */
	minLeadMs?: number;
}

/**
 * Throw when `atMs` is in the past, equal to `nowMs`, or within the
 * grace window. The error message names the exact delta so the operator
 * (or the model parsing the result on retry) can self-correct.
 */
export function assertFutureAtTimestamp(
	atMs: number,
	nowMs: number,
	opts?: AssertFutureAtTimestampOptions,
): void {
	const minLeadMs = Math.max(0, opts?.minLeadMs ?? AT_MIN_LEAD_MS);
	if (!Number.isFinite(atMs)) {
		throw new Error("cron `at` timestamp must be a finite epoch-ms number");
	}
	const deltaMs = atMs - nowMs;
	if (deltaMs <= 0) {
		const ago = formatDelta(-deltaMs);
		throw new Error(
			`cron \`at\` schedule must be at least ${Math.round(minLeadMs / 1000)} seconds in the FUTURE; ` +
				`got ${new Date(atMs).toISOString()} which is ${ago} in the past. ` +
				`Did you mean tomorrow at this time? Compute the NEXT future instance of the named clock time.`,
		);
	}
	if (deltaMs < minLeadMs) {
		throw new Error(
			`cron \`at\` schedule must be at least ${Math.round(minLeadMs / 1000)} seconds in the FUTURE; ` +
				`got ${new Date(atMs).toISOString()} which is only ${formatDelta(deltaMs)} ahead. ` +
				`If you meant "right now", use \`kind: "every"\` with a short interval — otherwise compute the NEXT future instance of the named clock time.`,
		);
	}
}

/** Format a ms delta as a short human string for the validator error. */
function formatDelta(ms: number): string {
	const abs = Math.abs(ms);
	if (abs < 1000) return `${abs}ms`;
	if (abs < 60_000) return `${(abs / 1000).toFixed(1)}s`;
	if (abs < 3_600_000) return `${(abs / 60_000).toFixed(1)}min`;
	if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(1)}h`;
	return `${(abs / 86_400_000).toFixed(1)}d`;
}
