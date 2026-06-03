/**
 * Inbound → agent turn dispatcher (Step 25).
 *
 * Brand-scrubbed analogue of upstream's `dispatchAgentRunFromGateway`.
 * One function that:
 *
 *   1. Stamps a fresh runId (or uses the caller's idempotencyKey).
 *   2. Registers the session in Step 11's live-session registry.
 *   3. Hands the turn off to the LLM runtime (async, fire-and-forget).
 *   4. Responds to the caller IMMEDIATELY with `{ status: "accepted", runId }`.
 *   5. When the LLM run settles, emits the `lifecycle` agent event
 *      + (if the caller is waiting for the final via `agent.wait`) sends a
 *      paired final-frame response.
 *
 * Brigade's runtime is not yet wired through this dispatcher — today the
 * LLM-execution side is provided via dependency injection (`runAgentTurn`)
 * so test fixtures can pass a stub and integration tests can wire the
 * actual Pi runtime.
 */

import crypto from "node:crypto";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { emitAgentEvent } from "../agents/agent-events.js";
import {
	registerLiveSession,
	unregisterLiveSession,
} from "../agents/session-registry.js";
import { resolveAgentIdFromSessionKey } from "../agents/routing/session-key.js";
import { resolveSessionLane } from "../process/session-lane.js";

const log = createSubsystemLogger("core/agent-dispatcher");

/**
 * Wave O0.7 - tease the child's final assistant text out of the
 * runAgentTurn result so the lifecycle `phase:"end"` event can carry it.
 *
 * Adapters return one of three shapes:
 *   - { ok, reply?: string }                                  (TUI/cron path)
 *   - { ok, result: { reply?: string } }                      (legacy)
 *   - { ok, result: RunSingleTurnResult }                     (Pi runtime adapter)
 *
 * Returns the first non-empty string found, or undefined.
 */
function extractReplyFromResult(
	result: { ok: boolean; error?: string; result?: unknown; reply?: string },
): string | undefined {
	if (typeof result.reply === "string" && result.reply.trim()) {
		return result.reply;
	}
	const inner = result.result as { reply?: unknown } | undefined;
	if (inner && typeof inner.reply === "string" && inner.reply.trim()) {
		return inner.reply;
	}
	return undefined;
}

export interface DispatchAgentRunParams {
	sessionKey: string;
	message: string;
	idempotencyKey?: string;
	lane?: string;
	channel?: string;
	accountId?: string;
	to?: string;
	threadId?: string | number;
	thinking?: string;
	deliver?: boolean;
	timeout?: number;
	label?: string;
	extraSystemPrompt?: string;
	spawnedBy?: string;
	workspaceDir?: string;
	/** Caller-supplied agent id; overrides `resolveAgentIdFromSessionKey(sessionKey)` when set. */
	agentId?: string;
}

export interface DispatchAgentRunDeps {
	/**
	 * Concrete LLM-runner. Receives the dispatch params + the runId stamped
	 * by the dispatcher. Must return a promise that resolves on turn-end
	 * (success OR error). Brigade's Pi-runtime adapter satisfies this when
	 * it's wired in a later step.
	 */
	runAgentTurn: (
		params: DispatchAgentRunParams & { runId: string },
	) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
}

export interface DispatchedRun {
	runId: string;
	sessionKey: string;
	settled: Promise<{ ok: boolean; error?: string; result?: unknown }>;
}

/**
 * Dispatch one inbound turn. Returns synchronously with `{ runId,
 * settled }`. The caller can either:
 *   - return `runId` to the requester immediately (most callers), or
 *   - `await settled` for a sync-style API (`agent.wait`).
 */
export function dispatchAgentRun(
	params: DispatchAgentRunParams,
	deps: DispatchAgentRunDeps,
): DispatchedRun {
	const runId = params.idempotencyKey ?? crypto.randomUUID();
	// Prefer the caller-supplied agentId (e.g. from a `prompt` RPC carrying an
	// explicit `agentId`) over the sessionKey-derived id. This avoids dropping
	// the routed agent on the floor when the sessionKey doesn't encode it.
	const agentId =
		params.agentId && params.agentId.trim().length > 0
			? params.agentId.trim()
			: resolveAgentIdFromSessionKey(params.sessionKey);
	const lane = params.lane ?? resolveSessionLane(params.sessionKey);
	const abortController = new AbortController();

	registerLiveSession({
		sessionKey: params.sessionKey,
		sessionId: runId,
		agentId,
		runId,
		lane,
		abortController,
		metadata: {
			channel: params.channel,
			accountId: params.accountId,
			threadId: params.threadId,
			// Wave O0.7 - thread spawn lineage onto the live-session metadata
			// so `sessions.list` can surface "spawnedBy" without a session-
			// store round-trip when the persisted entry has not been written
			// yet (sub-agent gateway handoff race).
			...(params.spawnedBy ? { spawnedBy: params.spawnedBy } : {}),
			...(params.label ? { label: params.label } : {}),
		},
	});

	emitAgentEvent({
		runId,
		stream: "lifecycle",
		sessionKey: params.sessionKey,
		data: {
			phase: "start",
			agentId,
			channel: params.channel,
			label: params.label,
		},
	});

	const settled = (async () => {
		try {
			// Forward the resolved agentId (caller-supplied OR sessionKey-derived)
			// so downstream `runAgentTurn` adapters don't have to re-resolve it.
			const result = await deps.runAgentTurn({ ...params, agentId, runId });
			// Wave O0.7 - thread the child's final reply text on the
			// lifecycle `phase:"end"` payload so the completion bridge can
			// deliver it into the parent's inbox. The runner now returns
			// `result.reply` whenever the adapter is able to read the
			// session's last assistant text; if it can't, the bridge falls
			// back to the registry's frozenResultText capture.
			const replyText = extractReplyFromResult(result);
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				sessionKey: params.sessionKey,
				data: {
					phase: "end",
					ok: result.ok,
					...(result.error ? { error: result.error } : {}),
					...(replyText ? { reply: replyText } : {}),
				},
			});
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn("agent turn threw", { runId, sessionKey: params.sessionKey, error: message });
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				sessionKey: params.sessionKey,
				data: { phase: "end", ok: false, error: message },
			});
			return { ok: false, error: message };
		} finally {
			try {
				unregisterLiveSession(params.sessionKey);
			} catch {
				// best-effort unregister
			}
		}
	})();

	return { runId, sessionKey: params.sessionKey, settled };
}
