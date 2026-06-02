/**
 * Sub-agent completion helpers.
 *
 * Pure helpers (`runOutcomesEqual`, `resolveLifecycleOutcomeFromRunOutcome`)
 * + the idempotent hook-emission gate (`emitSubagentEndedHookOnce`).
 *
 * Brand-scrubbed lift of upstream's `src/agents/subagent-registry-completion.ts`.
 *
 * Brigade does not yet have a generic hook-runner module — Step 18 (agent
 * events + gateway-call factory) lands that. Until then, the emit gate
 * funnels through `getSubagentEndedHook()`, which is `null` by default
 * and is swappable by callers via `setSubagentEndedHook(handler)`. This
 * preserves the upstream idempotency contract (`endedHookEmittedAt` set
 * exactly once per run) without forcing the hook-bus lift early.
 */

import {
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
	SUBAGENT_TARGET_KIND_SUBAGENT,
	type SubagentLifecycleEndedOutcome,
	type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunOutcome, SubagentRunRecord } from "./subagent-registry.types.js";

export function runOutcomesEqual(
	a: SubagentRunOutcome | undefined,
	b: SubagentRunOutcome | undefined,
): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.status !== b.status) return false;
	if (a.status === "error" && b.status === "error") {
		return (a.error ?? "") === (b.error ?? "");
	}
	return true;
}

export function resolveLifecycleOutcomeFromRunOutcome(
	outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
	if (outcome?.status === "error") return SUBAGENT_ENDED_OUTCOME_ERROR;
	if (outcome?.status === "timeout") return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
	return SUBAGENT_ENDED_OUTCOME_OK;
}

/**
 * Hook handler signature — receives the lifecycle-ended payload + the
 * minimal source-context the registry threads from the SubagentRunRecord.
 */
export type SubagentEndedHookPayload = {
	targetSessionKey: string;
	targetKind: typeof SUBAGENT_TARGET_KIND_SUBAGENT;
	reason: SubagentLifecycleEndedReason;
	sendFarewell?: boolean;
	accountId?: string;
	runId: string;
	endedAt?: number;
	outcome?: SubagentLifecycleEndedOutcome;
	error?: string;
};

export type SubagentEndedHookSource = {
	runId: string;
	childSessionKey: string;
	requesterSessionKey: string;
};

export type SubagentEndedHookHandler = (
	payload: SubagentEndedHookPayload,
	source: SubagentEndedHookSource,
) => Promise<void> | void;

let subagentEndedHook: SubagentEndedHookHandler | null = null;

/** Install a hook handler. Pass `null` to clear. */
export function setSubagentEndedHook(handler: SubagentEndedHookHandler | null): void {
	subagentEndedHook = handler;
}

/** Read the current handler, primarily for tests. */
export function getSubagentEndedHook(): SubagentEndedHookHandler | null {
	return subagentEndedHook;
}

export async function emitSubagentEndedHookOnce(params: {
	entry: SubagentRunRecord;
	reason: SubagentLifecycleEndedReason;
	sendFarewell?: boolean;
	accountId?: string;
	outcome?: SubagentLifecycleEndedOutcome;
	error?: string;
	inFlightRunIds: Set<string>;
	persist: () => void;
}): Promise<boolean> {
	const runId = params.entry.runId.trim();
	if (!runId) return false;
	if (params.entry.endedHookEmittedAt) return false;
	if (params.inFlightRunIds.has(runId)) return false;

	params.inFlightRunIds.add(runId);
	try {
		const handler = subagentEndedHook;
		if (!handler) {
			// No hook installed yet (pre-Step 18): treat the registry-side
			// idempotency stamp as the contract surface, but skip the emit.
			params.entry.endedHookEmittedAt = Date.now();
			params.persist();
			return true;
		}
		await handler(
			{
				targetSessionKey: params.entry.childSessionKey,
				targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
				reason: params.reason,
				sendFarewell: params.sendFarewell,
				accountId: params.accountId,
				runId: params.entry.runId,
				endedAt: params.entry.endedAt,
				outcome: params.outcome,
				error: params.error,
			},
			{
				runId: params.entry.runId,
				childSessionKey: params.entry.childSessionKey,
				requesterSessionKey: params.entry.requesterSessionKey,
			},
		);
		params.entry.endedHookEmittedAt = Date.now();
		params.persist();
		return true;
	} catch {
		return false;
	} finally {
		params.inFlightRunIds.delete(runId);
	}
}
