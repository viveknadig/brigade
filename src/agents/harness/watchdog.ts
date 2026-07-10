// src/agents/harness/watchdog.ts
//
// Suspend a harness child's liveness watchdogs while BRIGADE is the one working.
//
// A harness backend spawns an external binary and watches it for signs of life:
// if it emits nothing for `noOutputTimeoutMs`, it is presumed wedged and killed.
// That is exactly right while the binary is thinking. It is exactly wrong while
// the binary is BLOCKED ON US.
//
// When the binary calls a Brigade tool over the MCP route it writes nothing to
// stdout for the whole duration of that call — and some of those calls are long
// by design:
//
//   • `spawn_agent` runs an entire sub-agent turn, which may itself pause twice
//     on a five-minute operator approval;
//   • `generate_video` has its own 1,220,000 ms budget;
//   • an exec-gated `bash` waits on the operator.
//
// With a 360s no-output grace the parent would SIGKILL itself mid-tool — and the
// route's socket-close handler would then abort the child work it was waiting for.
// The binary is not wedged; it is waiting on Brigade, and Brigade already bounds
// that time (every tool carries its own timeout). So we pause both watchdogs for
// precisely that window and resume them afterwards, extending the hard ceiling by
// the paused duration rather than letting it consume time we spent working.
//
// Keyed by the per-turn tool-plane token, which is the one identifier both sides
// already hold: the transport wrote it into the child's `--mcp-config`, and the
// route reads it off the request path. Registration is best-effort and the whole
// mechanism degrades to today's behaviour if a key is missing.

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/** What a spawned harness child exposes so its watchdogs can be suspended. */
export interface HarnessWatchdog {
	/** Suspend the liveness timers. Returns a resume fn; safe to call repeatedly
	 *  (nested pauses are counted, and each resume is idempotent). */
	pause(): () => void;
}

const KEY = Symbol.for("brigade.harness.watchdogs");

function registry(): Map<string, HarnessWatchdog> {
	return resolveGlobalSingleton<Map<string, HarnessWatchdog>>(KEY, () => new Map());
}

/** Called by the transport once it has spawned the child for this turn. */
export function registerHarnessWatchdog(token: string, watchdog: HarnessWatchdog): void {
	if (!token) return;
	registry().set(token, watchdog);
}

/** Called by the transport when the child exits. Idempotent. */
export function unregisterHarnessWatchdog(token: string): void {
	if (!token) return;
	registry().delete(token);
}

/**
 * Suspend the child's watchdogs for the duration of a tool call. Returns a resume
 * fn — ALWAYS call it in a `finally`. Unknown token (the memory-only stdio plane,
 * a cold path, a child that already exited) yields a harmless no-op, so the caller
 * never has to branch.
 */
export function pauseHarnessWatchdog(token: string): () => void {
	const wd = registry().get(token);
	if (!wd) return () => {};
	try {
		return wd.pause();
	} catch {
		return () => {};
	}
}

/** Test seam. */
export function __clearHarnessWatchdogs(): void {
	registry().clear();
}
