/**
 * In-memory sub-agent run registry.
 *
 * Brand-scrubbed analogue of upstream's `src/agents/subagent-registry.ts`,
 * scoped to the surface Brigade's Step 11-25 consumers need today:
 *
 *   - `registerSubagentRun(entry)` — add a fresh run.
 *   - `getSubagentRun(runId)` / `getSubagentRunByChildSessionKey(key)`
 *     — look up by id or by the child's session key (prefers active runs;
 *     falls back to the most recent ended run when none active).
 *   - `listSubagentRunsForRequester(sessionKey)` — children of a session.
 *   - `countActiveRunsForSession(sessionKey)` — live-run count.
 *   - `markSubagentRunCompleted(runId, outcome)` — set `endedAt` + outcome
 *     under the in-flight guard.
 *   - `releaseSubagentRun(runId)` — remove from registry.
 *   - `resetSubagentRegistryForTests()` — wipe every Map (test-only).
 *
 * What's intentionally DEFERRED to later steps:
 *
 *   - Disk persistence (`runs.json`) → not needed until multi-process
 *     gateway shards (Step 25+). When it lands it slots in behind a
 *     `persist()` callback identical to upstream's pattern; no consumer
 *     change.
 *   - Sweeper (TTL'd archive deletion) → cron service ties in there.
 *   - Lifecycle-event listener (`onAgentEvent`) → Step 18 lift.
 *   - Steer-restart marker flow → Step 20 (subagent-spawn engine).
 *   - Descendant transitive counts → Step 11 (SessionContext + Inbox).
 *
 * All of those land as additive additions; the public APIs here stay
 * stable.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitSubagentEndedHookOnce } from "./subagent-registry-completion.js";
import type {
	SubagentLifecycleEndedOutcome,
	SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunOutcome, SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRegistryState = {
	runs: Map<string, SubagentRunRecord>;
	endedHookInFlight: Set<string>;
};

const SUBAGENT_REGISTRY_STATE_KEY = Symbol.for("brigade.subagentRegistryState");

function createState(): SubagentRegistryState {
	return {
		runs: new Map(),
		endedHookInFlight: new Set(),
	};
}

function getState(): SubagentRegistryState {
	return resolveGlobalSingleton<SubagentRegistryState>(SUBAGENT_REGISTRY_STATE_KEY, createState);
}

/** Register a new sub-agent run. Overwrites any existing entry with the same `runId`. */
export function registerSubagentRun(entry: SubagentRunRecord): SubagentRunRecord {
	const state = getState();
	state.runs.set(entry.runId, entry);
	return entry;
}

/** Look up by runId. */
export function getSubagentRun(runId: string): SubagentRunRecord | undefined {
	if (!runId) return undefined;
	return getState().runs.get(runId);
}

/**
 * Look up by the child's session key.
 *
 * Returns the active run if one exists (no `endedAt`), otherwise the
 * most-recently-ended run. `undefined` if neither.
 */
export function getSubagentRunByChildSessionKey(
	childSessionKey: string,
): SubagentRunRecord | undefined {
	if (!childSessionKey) return undefined;
	const state = getState();
	let active: SubagentRunRecord | undefined;
	let latestEnded: SubagentRunRecord | undefined;
	let latestEndedAt = 0;
	for (const entry of state.runs.values()) {
		if (entry.childSessionKey !== childSessionKey) continue;
		if (entry.endedAt == null) {
			active = entry;
			continue;
		}
		if (entry.endedAt > latestEndedAt) {
			latestEnded = entry;
			latestEndedAt = entry.endedAt;
		}
	}
	return active ?? latestEnded;
}

/** Return every run requested by the given session, in creation order. */
export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
	if (!requesterSessionKey) return [];
	const state = getState();
	const out: SubagentRunRecord[] = [];
	for (const entry of state.runs.values()) {
		if (entry.requesterSessionKey === requesterSessionKey) out.push(entry);
	}
	out.sort((a, b) => a.createdAt - b.createdAt);
	return out;
}

/** Return every active (no `endedAt`) run controlled by the given session. */
export function listActiveSubagentRunsForController(
	controllerSessionKey: string,
): SubagentRunRecord[] {
	if (!controllerSessionKey) return [];
	const state = getState();
	const out: SubagentRunRecord[] = [];
	for (const entry of state.runs.values()) {
		if (entry.controllerSessionKey !== controllerSessionKey) continue;
		if (entry.endedAt != null) continue;
		out.push(entry);
	}
	return out;
}

/**
 * Collect the set of child session keys spawned by `parentSessionKey`,
 * walking transitive descendants. Used by the agent loop to populate the
 * `spawnedKeys` field on `sessionToolAccess` so visibility="tree" actually
 * allows the parent to reach its own sub-agents.
 *
 * Returns an empty set when the parent has no recorded children. The walk
 * caps at a defensive depth (32) so a malformed registry can never spin
 * the caller forever.
 */
export function getSpawnedKeysForSession(parentSessionKey: string): Set<string> {
	const out = new Set<string>();
	if (!parentSessionKey) return out;
	const state = getState();
	if (state.runs.size === 0) return out;
	const queue: string[] = [parentSessionKey];
	let depth = 0;
	while (queue.length > 0 && depth < 32) {
		const next: string[] = [];
		for (const requester of queue) {
			for (const entry of state.runs.values()) {
				if (entry.requesterSessionKey !== requester) continue;
				const childKey = entry.childSessionKey;
				if (!childKey || out.has(childKey)) continue;
				out.add(childKey);
				next.push(childKey);
			}
		}
		if (next.length === 0) break;
		queue.length = 0;
		queue.push(...next);
		depth += 1;
	}
	return out;
}

/** Active-run count for a requester session. */
export function countActiveRunsForSession(requesterSessionKey: string): number {
	if (!requesterSessionKey) return 0;
	const state = getState();
	let n = 0;
	for (const entry of state.runs.values()) {
		if (entry.requesterSessionKey !== requesterSessionKey) continue;
		if (entry.endedAt != null) continue;
		n += 1;
	}
	return n;
}

/** `true` while the run is registered and has no `endedAt`. */
export function isSubagentSessionRunActive(childSessionKey: string): boolean {
	const entry = getSubagentRunByChildSessionKey(childSessionKey);
	return Boolean(entry && entry.endedAt == null);
}

/**
 * Stamp a run as completed: sets `endedAt` + `outcome`, then fires the
 * `subagent_ended` hook once via the idempotent gate. Returns the
 * updated record, or `undefined` if the runId is unknown.
 */
export async function markSubagentRunCompleted(params: {
	runId: string;
	outcome: SubagentRunOutcome;
	reason: SubagentLifecycleEndedReason;
	lifecycleOutcome: SubagentLifecycleEndedOutcome;
	sendFarewell?: boolean;
	accountId?: string;
	error?: string;
	endedAt?: number;
}): Promise<SubagentRunRecord | undefined> {
	const state = getState();
	const entry = state.runs.get(params.runId);
	if (!entry) return undefined;
	const endedAt = params.endedAt ?? Date.now();
	entry.endedAt = endedAt;
	entry.outcome = params.outcome;
	entry.endedReason = params.reason;
	await emitSubagentEndedHookOnce({
		entry,
		reason: params.reason,
		sendFarewell: params.sendFarewell,
		accountId: params.accountId,
		outcome: params.lifecycleOutcome,
		error: params.error,
		inFlightRunIds: state.endedHookInFlight,
		persist: () => {
			// In-memory only today — disk persistence lands in a later step.
		},
	});
	return entry;
}

/** Remove a run from the registry. Returns `true` if it was present. */
export function releaseSubagentRun(runId: string): boolean {
	if (!runId) return false;
	return getState().runs.delete(runId);
}

/** Test-only — wipe every Map + Set in the registry state. */
export function resetSubagentRegistryForTests(): void {
	const state = getState();
	state.runs.clear();
	state.endedHookInFlight.clear();
}

/** Test-only — snapshot of every run currently registered. */
export function snapshotSubagentRunsForTests(): SubagentRunRecord[] {
	return [...getState().runs.values()];
}
