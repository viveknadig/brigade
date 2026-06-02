/**
 * Re-export shim for the OS-level cross-process session-file lock.
 *
 * Brigade ships ONE implementation at `../sessions/session-write-lock.ts`
 * (PID-tagged lockfile + stale-stealing). The lock guards both:
 *   - JSONL session transcript appends (sessions/...)
 *   - The shared `brigade-store.json` file mutations (this directory's
 *     `./session-store.ts` + `./session-store-lock.ts`).
 *
 * The actual primitive lives one directory over; this re-export keeps the
 * `agents/` neighbourhood's import paths stable so callers don't reach
 * across the subsystem boundary unnecessarily.
 */

export {
	acquireSessionWriteLock,
	type AcquireSessionWriteLockArgs,
	type SessionWriteLock,
} from "../sessions/session-write-lock.js";
