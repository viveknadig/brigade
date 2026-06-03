/**
 * Sub-agent completion bridge.
 *
 * Closes the loop that the audit caught: Step 10's `markSubagentRunCompleted`
 * was exported but never called. Without this listener, every sub-agent
 * spawn left a permanent in-memory registry entry until process restart —
 * registry leak under normal usage.
 *
 * Wiring:
 *
 *   1. Subscribes to the unified agent-events bus (Step 18).
 *   2. Watches `lifecycle` stream events with `phase: "end"`.
 *   3. Looks up the sub-agent run by `runId` via Step 10's registry.
 *   4. Calls `markSubagentRunCompleted({runId, outcome, reason, …})` so the
 *      registry stamps `endedAt` + fires the (idempotent) `subagent_ended`
 *      hook — Step 18's bridge then emits a `subagent_lifecycle` event
 *      for downstream listeners.
 *   5. Enqueues a completion announce into the PARENT session's inbox
 *      (`session-inbox.ts:enqueueSystemEvent`) so the parent's next turn
 *      sees "your sub-agent <label> completed: …" — fills the producer
 *      gap Audit 11 flagged.
 *
 * Cleanly idempotent: `markSubagentRunCompleted` short-circuits when
 * the entry already has `endedAt`, and `emitSubagentEndedHookOnce` (used
 * inside) double-gates with `endedHookEmittedAt`. Two `phase: "end"`
 * events for the same runId — possible during a retry storm — both
 * resolve to a single completion stamp.
 *
 * Boot wiring: `installSubagentCompletionBridge()` returns a disposer.
 * `agents/agent-events.ts:wireAgentEventsBridge()` installs this bridge
 * alongside the sub-agent ended hook + heartbeat hook + session-state
 * listener so all four flow from one call at gateway boot.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { onAgentEvent } from "./agent-events.js";
import {
	deliverSubagentCompletionAnnounce,
	pickReplyTextFromRegistryEntry,
} from "./subagent-announce-delivery.js";
import {
	getSubagentRun,
	markSubagentRunCompleted,
} from "./subagent-registry.js";
import {
	SUBAGENT_ENDED_OUTCOME_ABORT,
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
	type SubagentLifecycleEndedOutcome,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunOutcome } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-completion-bridge");

type BridgeState = {
	disposeListener: (() => void) | null;
};

const BRIDGE_STATE_KEY = Symbol.for("brigade.subagentCompletionBridge.state");

function getState(): BridgeState {
	return resolveGlobalSingleton<BridgeState>(BRIDGE_STATE_KEY, () => ({
		disposeListener: null,
	}));
}

function deriveOutcomes(data: Record<string, unknown>): {
	runOutcome: SubagentRunOutcome;
	lifecycleOutcome: SubagentLifecycleEndedOutcome;
	error?: string;
	reason: string;
	replyText?: string;
} {
	const ok = data.ok;
	const error = typeof data.error === "string" ? data.error : undefined;
	const timedOut = data.timedOut === true || data.reason === "timeout";
	const aborted = data.aborted === true || data.reason === "abort" || data.reason === "aborted";
	// Wave O0.7 - lifecycle producers (agent-dispatcher) now thread the
	// child's final assistant text on the `phase:"end"` payload as
	// `reply`. The completion bridge plucks it here so the announce-
	// delivery payload carries the actual child output to the parent.
	const replyText = typeof data.reply === "string" ? data.reply : undefined;
	if (aborted) {
		return {
			runOutcome: { status: "abort", ...(replyText ? { text: replyText } : {}) },
			lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_ABORT,
			reason: "abort",
			...(error ? { error } : {}),
			...(replyText ? { replyText } : {}),
		};
	}
	if (timedOut) {
		return {
			runOutcome: { status: "timeout", ...(replyText ? { text: replyText } : {}) },
			lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_TIMEOUT,
			reason: "timeout",
			...(error ? { error } : {}),
			...(replyText ? { replyText } : {}),
		};
	}
	if (ok === false || error) {
		return {
			runOutcome: {
				status: "error",
				error: error ?? "unknown error",
				...(replyText ? { text: replyText } : {}),
			},
			lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_ERROR,
			reason: "error",
			error: error ?? "unknown error",
			...(replyText ? { replyText } : {}),
		};
	}
	return {
		runOutcome: { status: "ok", ...(replyText ? { text: replyText } : {}) },
		lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_OK,
		reason: "complete",
		...(replyText ? { replyText } : {}),
	};
}

// Wave O0.7 - the rich announce text now lives in
// `subagent-announce-delivery.ts`; the bridge just passes the entry and
// the lifecycle outcome through. Keep the legacy short-form helper
// available for callers that only want the headline (e.g. log lines).
function formatLegacyAnnounceHeadline(params: {
	label?: string;
	outcome: SubagentLifecycleEndedOutcome;
	error?: string;
}): string {
	const tag = params.label?.trim() ? ` "${params.label.trim()}"` : "";
	if (params.outcome === SUBAGENT_ENDED_OUTCOME_OK) {
		return `Sub-agent${tag} completed successfully.`;
	}
	if (params.outcome === SUBAGENT_ENDED_OUTCOME_TIMEOUT) {
		return `Sub-agent${tag} timed out.`;
	}
	if (params.outcome === SUBAGENT_ENDED_OUTCOME_ABORT) {
		return `Sub-agent${tag} was aborted.`;
	}
	const detail = params.error?.trim() ? `: ${params.error.trim()}` : "";
	return `Sub-agent${tag} failed${detail}`;
}
// Local alias kept so the inbox-fallback branch below (Wave O0.7) can
// fall back to the short-form when `enqueueSystemEvent` is bypassed.
const formatAnnounceText = formatLegacyAnnounceHeadline;

/**
 * Install the bridge. Returns a disposer that unsubscribes from the
 * agent-events bus. Idempotent — re-installing replaces the previous
 * listener.
 */
export function installSubagentCompletionBridge(): () => void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}

	const dispose = onAgentEvent((event) => {
		if (event.stream !== "lifecycle") return;
		const data = event.data ?? {};
		if ((data as { phase?: unknown }).phase !== "end") return;
		const runId = event.runId?.trim();
		if (!runId) return;
		const entry = getSubagentRun(runId);
		if (!entry) return;
		// Already stamped — Step 10's `markSubagentRunCompleted` is
		// idempotent, but skipping the call avoids needless work + log noise.
		if (entry.endedAt) return;

		const { runOutcome, lifecycleOutcome, error, reason, replyText } = deriveOutcomes(
			data as Record<string, unknown>,
		);

		void (async () => {
			try {
				await markSubagentRunCompleted({
					runId,
					outcome: runOutcome,
					reason,
					lifecycleOutcome,
					...(error ? { error } : {}),
				});
			} catch (err) {
				log.warn("markSubagentRunCompleted threw", {
					runId,
					error: (err as Error)?.message,
				});
			}

			// Wave O0.7 - announce-delivery into the parent's session inbox so
			// the parent's next turn sees "child X finished, here is the
			// reply". The dedicated module formats the rich message body
			// (status + duration + truncated reply) and gates the enqueue
			// idempotently on `subagent:ended:<runId>`.
			const parentSessionKey =
				entry.requesterSessionKey?.trim() || entry.controllerSessionKey?.trim();
			if (!parentSessionKey || parentSessionKey === "main") {
				// Parent is the operator's main session or unknown - the TUI
				// sees lifecycle events directly via Step 18's agent-events
				// stream, no inbox needed.
				return;
			}
			try {
				// Prefer the reply text carried on the lifecycle event, else
				// pull whatever the registry already captured for the run.
				const fallbackReply = replyText ?? pickReplyTextFromRegistryEntry(entry);
				const durationMs =
					typeof entry.createdAt === "number"
						? Math.max(0, Date.now() - entry.createdAt)
						: undefined;
				const enqueued = deliverSubagentCompletionAnnounce({
					parentSessionKey,
					childSessionKey: entry.childSessionKey,
					runId,
					outcome: lifecycleOutcome,
					...(entry.label ? { label: entry.label } : {}),
					...(error ? { error } : {}),
					...(fallbackReply ? { replyText: fallbackReply } : {}),
					...(durationMs !== undefined ? { durationMs } : {}),
				});
				if (!enqueued) {
					// Fall back to the short-form text if the rich announce
					// was deduped or the inbox dropped it. The headline is
					// still useful for observability.
					const text = formatAnnounceText({
						label: entry.label,
						outcome: lifecycleOutcome,
						error,
					});
					log.debug("subagent announce inbox enqueue dropped; headline only", {
						runId,
						parentSessionKey,
						text,
					});
				}
			} catch (err) {
				log.warn("subagent completion announce enqueue failed", {
					runId,
					parentSessionKey,
					error: (err as Error)?.message,
				});
			}
		})();
	});

	state.disposeListener = dispose;
	return () => {
		const current = getState();
		if (current.disposeListener === dispose) {
			dispose();
			current.disposeListener = null;
		} else {
			dispose();
		}
	};
}

/** Test-only — clear bridge state. */
export function resetSubagentCompletionBridgeForTests(): void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}
}
