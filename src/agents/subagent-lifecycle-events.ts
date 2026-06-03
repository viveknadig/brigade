/**
 * Sub-agent lifecycle event constants.
 *
 * Brand-scrubbed lift of upstream's `src/agents/subagent-lifecycle-events.ts`,
 * trimmed to the literals the registry + completion helpers need today.
 * Step 18 (agent events + gateway-call factory) wires these to an actual
 * emitter; today they exist so the registry's types are concrete.
 */

export const SUBAGENT_ENDED_OUTCOME_OK = "ok" as const;
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error" as const;
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout" as const;
/**
 * Wave O0.7 - `abort` outcome distinguishes a parent-cancelled child from
 * the generic "error" bucket. Used by the parent-abort cascade so the
 * announce-delivery's completion text can render "was aborted" instead of
 * the misleading "failed".
 */
export const SUBAGENT_ENDED_OUTCOME_ABORT = "abort" as const;

export type SubagentLifecycleEndedOutcome =
	| typeof SUBAGENT_ENDED_OUTCOME_OK
	| typeof SUBAGENT_ENDED_OUTCOME_ERROR
	| typeof SUBAGENT_ENDED_OUTCOME_TIMEOUT
	| typeof SUBAGENT_ENDED_OUTCOME_ABORT;

export const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent" as const;
export const SUBAGENT_TARGET_KIND_ACP = "acp" as const;

export type SubagentTargetKind =
	| typeof SUBAGENT_TARGET_KIND_SUBAGENT
	| typeof SUBAGENT_TARGET_KIND_ACP;

/**
 * Reason a sub-agent run ended. Free-form on purpose — the catalogue
 * grows as new entry-points are added (e.g. cron timeouts, manual kills,
 * upstream provider 5xx exhaustion). Restricting the union early would
 * just force a churn cascade across the lifecycle emitter when a new
 * source comes online.
 */
export type SubagentLifecycleEndedReason = string;
