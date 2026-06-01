/**
 * Heartbeat — drains pending system events for the operator's main session
 * by running a synthetic agent turn, so a cron with `wakeMode: "now"` can
 * surface its reminder WITHOUT waiting for the operator to type next.
 *
 * Why it exists: today the cron service has THREE paths for getting an
 * announce to the operator —
 *
 *   1. live `system-event` WS broadcast → connect-mode TUI bubble
 *      (works when the operator has a TUI connected)
 *   2. per-session pending-event queue → drained into the NEXT operator
 *      prompt as a `<system_event>` block
 *      (works when the operator eventually types something)
 *   3. heartbeat-driven synthetic turn (this file) → drains the same
 *      queue + the model produces a reply that lands wherever the
 *      operator's delivery surface is
 *      (works for idle operators on `wakeMode: "now"`)
 *
 * Without #3, `wakeMode: "now"` is meaningless — the WS broadcast handles
 * the TUI case, but a cron firing for an operator who's on WhatsApp (no
 * TUI connected) and not actively typing would have to wait for the
 * operator's next message before the model could "react" to it.
 *
 * Design choices:
 *
 *   - **No periodic tick.** OC runs heartbeats on a wall-clock cadence;
 *     Brigade doesn't need that because the WS broadcast handles live
 *     visibility. Heartbeats here ONLY fire on explicit
 *     `requestHeartbeatNow()` — i.e. when a cron has signalled
 *     `wakeMode: "now"` AND has events queued. This avoids burning a
 *     model call every minute "just in case".
 *
 *   - **Skip when the Main lane is busy.** If the operator is mid-turn
 *     (typing, or a previous prompt is still streaming), the pending
 *     events will drain naturally on that in-flight turn's
 *     pre-Pi-message prefix. Forcing a second turn would just block
 *     behind the lane queue and risk doubling up.
 *
 *   - **Skip when no events are pending.** A heartbeat with nothing to
 *     drain is wasted work. The cron service is the only producer of
 *     pending events today, so "events pending" is a cheap check.
 */

import { runResilientTurn } from "./agent-loop.js";
import {
	listPendingSystemEvents,
} from "./pending-system-events.js";
import { CommandLane, getLaneQueueSize } from "../process/lanes.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("brigade/heartbeat");

/**
 * Args the gateway hands to the heartbeat runner. The runner needs to be
 * able to start a real Pi turn, so it gets the same provider+model the
 * operator's last interactive turn used; it also needs `agentId` +
 * `sessionKey` so the right transcript/queue gets the drain.
 */
export interface HeartbeatRunnerArgs {
	agentId: string;
	sessionKey: string;
	provider: string;
	modelId: string;
	thinkingLevel?: "off" | "low" | "medium" | "high";
	/** Optional reason for the heartbeat — surfaces in logs only. */
	reason?: string;
}

/**
 * Fire one heartbeat. Returns a status the cron service can log:
 *   - `"ran"`           — synthetic turn ran successfully.
 *   - `"skipped-busy"`  — Main lane has work in flight; the existing
 *                         in-flight turn will drain events naturally.
 *   - `"skipped-empty"` — no pending events to drain. No-op.
 *   - `"failed"`        — the synthetic turn threw; details in logs.
 */
export type HeartbeatResult = "ran" | "skipped-busy" | "skipped-empty" | "failed";

export async function runHeartbeatNow(
	args: HeartbeatRunnerArgs,
): Promise<HeartbeatResult> {
	// Skip if the Main lane is already running a turn — that turn's
	// pre-prompt drain (in agent-loop.ts) will pick up our queued events,
	// so we don't need to fire a second turn. Forcing one would just chain
	// behind the in-flight turn and double-drain.
	if (getLaneQueueSize(CommandLane.Main) > 0) {
		log.info("heartbeat skipped — main lane busy", {
			sessionKey: args.sessionKey,
			reason: args.reason,
		});
		return "skipped-busy";
	}
	// Skip if there's nothing to drain — a heartbeat without pending events
	// would just burn a model call to say "ok nothing happened".
	const pending = listPendingSystemEvents(args.sessionKey);
	if (pending.length === 0) {
		log.info("heartbeat skipped — no pending events for session", {
			sessionKey: args.sessionKey,
			reason: args.reason,
		});
		return "skipped-empty";
	}
	// Synthetic turn — the user message is empty; the pending-events drain
	// in agent-loop.ts will populate the prompt prefix with `<system_event>`
	// blocks. The model sees ONLY those blocks + the persona/system prompt
	// and produces a reply addressing whatever the cron event said.
	try {
		await runResilientTurn({
			agentId: args.agentId,
			provider: args.provider,
			modelId: args.modelId,
			message: "",
			sessionKey: args.sessionKey,
			...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
		});
		log.info("heartbeat ran", {
			sessionKey: args.sessionKey,
			reason: args.reason,
			drained: pending.length,
		});
		return "ran";
	} catch (err) {
		log.warn("heartbeat synthetic turn threw", {
			sessionKey: args.sessionKey,
			reason: args.reason,
			error: err instanceof Error ? err.message : String(err),
		});
		return "failed";
	}
}
