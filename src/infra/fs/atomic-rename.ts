/**
 * Shared atomic-rename helpers with bounded retry on transient Windows
 * filesystem errors (EPERM / EBUSY / EACCES). Used by every component that
 * needs tmp+rename durability — the cron store, the run-log pruner, and
 * any future on-disk JSONL writer.
 *
 * Why a helper rather than bare `fs.renameSync`:
 *   On Windows, antivirus / search-indexer / Defender briefly holds an open
 *   handle on the destination file as a freshly-written tmp lands. The
 *   resulting rename fails with EPERM/EBUSY even though the file is
 *   absolutely fine — a short retry with backoff resolves it. Linux/macOS
 *   never see this; the helper is a no-op there (single attempt).
 */

import fs from "node:fs";

/** Codes that warrant a retry. Anything else is an immediate hard error. */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameWithRetryOptions {
	/** Total attempts (including the first). Default 5. */
	attempts?: number;
	/** Sleep between attempts in ms. Default 50. */
	delayMs?: number;
}

/**
 * Synchronous rename with bounded retry on transient Windows errors. The
 * sync variant exists for the cron-store hot path which needs blocking
 * semantics so the timer loop sees the new file before the next tick.
 */
export function renameWithRetry(
	src: string,
	dst: string,
	opts?: RenameWithRetryOptions,
): void {
	const attempts = Math.max(1, opts?.attempts ?? 5);
	const delayMs = Math.max(0, opts?.delayMs ?? 50);
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			fs.renameSync(src, dst);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (!code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
			if (i === attempts - 1) break;
			// Tiny busy-wait — we're in a sync hot path, can't await. The
			// retryable cases are 1-2 attempts in practice, so total stall is
			// well under 250ms even at the cap.
			const deadline = Date.now() + delayMs;
			while (Date.now() < deadline) {
				// no-op
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Async variant for `fs/promises` callers. Same retry semantics, but uses
 * `setTimeout` for the inter-attempt gap so the event loop is not blocked.
 */
export async function renameWithRetryAsync(
	src: string,
	dst: string,
	opts?: RenameWithRetryOptions,
): Promise<void> {
	const { promises: pfs } = await import("node:fs");
	const attempts = Math.max(1, opts?.attempts ?? 5);
	const delayMs = Math.max(0, opts?.delayMs ?? 50);
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			await pfs.rename(src, dst);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (!code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
			if (i === attempts - 1) break;
			await new Promise<void>((r) => setTimeout(r, delayMs));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
