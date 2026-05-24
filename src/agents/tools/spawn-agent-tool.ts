/**
 * `spawn_agent` tool — Primitive #6.
 *
 * The model calls this to delegate a self-contained task to a sub-agent.
 * The sub-agent runs its own Brigade session with the same persona but a
 * minimal system prompt (Commit 2), and returns its final reply as the
 * tool result. Heavy lifting — depth/concurrency limits, abort linking,
 * timeout enforcement — lives in `subagent-runner.ts` + `subagent-policy.ts`.
 *
 * The registry passes a `MakeSpawnAgentToolOptions` closure at construction
 * time so the tool's `execute` has the parent's session key + run id + abort
 * signal without needing to re-look them up at call time. That's the same
 * pattern memory tools use (capability injected at factory time).
 *
 * The runner module is loaded dynamically inside `execute` to break the
 * registry → tool → runner → agent-loop → session-wiring → registry static-
 * import cycle. By call time `agent-loop.js` is fully evaluated, so the
 * dynamic import resolves from cache.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
	DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	SubagentLimitError,
} from "../subagent-policy.js";
import { readNumberParam, readStringParam, textResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const SpawnAgentParams = Type.Object({
	task: Type.String({
		description:
			"What the sub-agent should do. Self-contained — it can't see this conversation.",
	}),
	label: Type.Optional(
		Type.String({
			description: "Short label (3-5 words) shown in logs and approval prompts.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override. Defaults to the parent's model." }),
	),
	thinking: Type.Optional(
		Type.Union(
			[Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
			{ description: "Thinking level. Default 'off'." },
		),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: `Timeout in seconds. Default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s.`,
		}),
	),
	// NOTE: `cleanup` is INTENTIONALLY NOT exposed to the model. A previous
	// implementation included it in the schema with a description nudging the
	// model toward "delete" for short tasks; gpt-5.5 read that as permission
	// and silently destroyed the child's transcript without operator consent.
	// Retention is now operator-controlled: `agents.defaults.subagents.cleanup`
	// in `brigade.json` (`"keep"` default) pins the policy for every spawn.
});

interface SpawnAgentDetails {
	/** ok = child returned a reply; aborted / timed-out = abort fired; limit-refused = policy block. */
	status: "ok" | "aborted" | "timed-out" | "limit-refused";
	label: string;
	childSessionKey?: string;
	durationMs?: number;
	/** Populated on `limit-refused` to expose the underlying SubagentLimitError.kind. */
	reason?: string;
}

export interface MakeSpawnAgentToolOptions {
	/** Parent's session key — drives the child's derived key + concurrency map. */
	parentSessionKey: string;
	/** Parent's agent id — sub-agent inherits unless we add an override later. */
	parentAgentId: string;
	/** Parent's run id (optional today, used for event correlation in Commit 4). */
	parentRunId?: string;
	/** Parent's abort signal — linked into the child's combined signal. */
	parentSignal?: AbortSignal;
	/**
	 * Parent's RESOLVED provider + modelId. The child inherits these unless
	 * the `spawn_agent` call's `model` param explicitly overrides. Without
	 * this seam, the runner would fall back to a hardcoded "anthropic" /
	 * "claude-opus-4-7" default — which crashes an Ollama-only operator
	 * with "Model not registered". Threading the parent's actual values
	 * through means the child always uses whatever the parent is using.
	 */
	parentProvider?: string;
	parentModelId?: string;
}

/**
 * Build the `spawn_agent` tool. Pure factory: captures the parent context in
 * a closure and returns a Brigade tool object. The body is the only place
 * Brigade tool code dynamically imports the runner, which is what keeps the
 * registry → runner cycle from biting at module-load time.
 */
export function makeSpawnAgentTool(
	opts: MakeSpawnAgentToolOptions,
): BrigadeTool<typeof SpawnAgentParams, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "spawn sub-agent",
		displaySummary: "spawning sub-agent",
		description:
			"Spawn a focused sub-agent. Use for parallel work, deep dives, or any " +
			"scoped task you'd rather not fill the main conversation with. The sub-agent " +
			"runs in its own session and returns its final reply as this tool's result.",
		parameters: SpawnAgentParams,
		async execute(
			_toolCallId,
			params,
			signal,
		): Promise<AgentToolResult<SpawnAgentDetails>> {
			const task = readStringParam(params, "task", { required: true });
			const label = readStringParam(params, "label") ?? "sub-agent";
			const model = readStringParam(params, "model");
			const thinkingRaw = readStringParam(params, "thinking");
			const thinking =
				thinkingRaw === "off" ||
				thinkingRaw === "low" ||
				thinkingRaw === "medium" ||
				thinkingRaw === "high"
					? thinkingRaw
					: undefined;
			const timeoutSeconds = readNumberParam(params, "timeoutSeconds", { integer: true });
			// `cleanup` is operator-controlled — never read from `params`. The
			// runner resolves it from `agents.defaults.subagents.cleanup` config
			// (defaults to "keep") so the model has no path to autonomously
			// delete a child's transcript.

			const combinedSignal = combineSignals(opts.parentSignal, signal);

			try {
				const { runSubagent } = await import("../subagent-runner.js");
				// Resolve provider + modelId: caller-supplied `model` wins; else
				// the parent's resolved values; else the runner falls back to
				// the workspace default. We pass `provider` ONLY when we know
				// it (always known if parent's values were threaded) so we
				// never set provider to undefined explicitly.
				const inheritedProvider = opts.parentProvider;
				const effectiveModel = model ?? opts.parentModelId;
				const result = await runSubagent({
					parentSessionKey: opts.parentSessionKey,
					parentAgentId: opts.parentAgentId,
					...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
					task,
					label,
					...(inheritedProvider !== undefined ? { provider: inheritedProvider } : {}),
					...(effectiveModel !== undefined ? { modelId: effectiveModel } : {}),
					...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
					...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
					...(combinedSignal !== undefined ? { parentSignal: combinedSignal } : {}),
					// No `cleanup` here — operator-controlled via config; the
					// runner resolves it from `subagents.defaultCleanup`.
				});
				if (result.aborted) {
					return textResult(result.reply, {
						status: result.timedOut ? "timed-out" : "aborted",
						label,
						childSessionKey: result.childSessionKey,
						durationMs: result.durationMs,
					});
				}
				return textResult(result.reply, {
					status: "ok",
					label,
					childSessionKey: result.childSessionKey,
					durationMs: result.durationMs,
				});
			} catch (err) {
				if (err instanceof SubagentLimitError) {
					return textResult(err.message, {
						status: "limit-refused",
						label,
						reason: err.kind,
					});
				}
				throw err;
			}
		},
	};
}

/**
 * Combine the tool's per-call abort signal (from Pi) with the parent's
 * captured signal so cancellation flows down to the child whether it
 * originates from the turn-level abort OR the tool-level abort.
 */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return undefined;
	if (live.length === 1) return live[0];
	const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
	if (typeof anyFn === "function") return anyFn(live);
	const controller = new AbortController();
	for (const s of live) {
		if (s.aborted) {
			controller.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}
