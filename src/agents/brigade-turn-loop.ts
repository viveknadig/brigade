/**
 * `runBrigadeTurnLoop` — Brigade's per-turn wrapper composition.
 *
 * Owns the 6-layer chain that protects every Pi prompt:
 *
 *     runWithFallback (multi-model failover)
 *       └─ runWithHeartbeat (status pings during silent streams)
 *          └─ runWithStreamTimeout (per-provider idle timeout)
 *             └─ runWithLengthContinuation (resume on truncation)
 *                └─ runWithContentQualityRetry (steer empty / reasoning-only)
 *                   └─ runWithThinkingFallback (auto-downgrade rejection)
 *                      └─ session.prompt(message) [Pi's actual loop]
 *
 * Pre-Phase-5 these wrappers were composed INLINE inside `chat.ts` and
 * `server.ts`, with UI callbacks passed at every layer. That meant two
 * problems:
 *
 *   1. The composition lived in two places (TUI + gateway), drifting
 *      whenever one was edited and the other wasn't.
 *   2. The TUI was tightly coupled to Pi's `AgentSession` because the
 *      wrappers all take `session` (their internal state needs it for
 *      streamFn introspection).
 *
 * Phase 5 moves the composition here and emits Brigade-bus events at
 * every callback site. Consumers subscribe to these via `onAgentEvent`
 * for inline UI rendering — the TUI sees a `turn-heartbeat` event and
 * inserts a "still working… 30s elapsed" line; the gateway sees the
 * same event and forwards it to all WebSocket clients via the existing
 * `pi`-style broadcast pattern.
 *
 * Net effect: one composition, one source of truth, one render path.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import {
	runWithContentQualityRetry,
	runWithFallback,
	runWithHeartbeat,
	runWithLengthContinuation,
	runWithStreamTimeout,
	runWithThinkingFallback,
} from "../core/agent.js";
import { pickStreamIdleMs } from "../core/model-caps.js";
import { emitAgentEvent } from "./agent-event-bus.js";

export interface RunBrigadeTurnLoopArgs {
	/** The Pi session whose `prompt` is the bottom of the chain. */
	session: AgentSession;
	/** Identifying metadata threaded into bus events for correlation. */
	runId: string;
	/** Per-turn user message (already scrubbed of refusal sentinels by Pi). */
	message: string;
	/** Optional fallback chain. Each entry is a model the loop will try
	 *  on the next failure of the primary. Empty = no fallback (primary
	 *  errors propagate). */
	fallbacks?: Array<{ model: Model<Api> }>;
	/** Idle-stream timeout. Defaults to `pickStreamIdleMs(session.model)`
	 *  so cloud / Ollama / reasoning models each get their own threshold. */
	idleMs?: number;
	/** Heartbeat interval (ms of silence between status pings). */
	heartbeatIntervalMs?: number;
}

/**
 * Run a single turn through Brigade's full safety stack. Resolves when
 * the turn settles (or rejects on unrecoverable error after fallback
 * exhaustion). All status events fire on the agent-event bus during
 * the run.
 */
export async function runBrigadeTurnLoop(args: RunBrigadeTurnLoopArgs): Promise<void> {
	const { session, runId, message, fallbacks = [], heartbeatIntervalMs = 30_000 } = args;
	const idleMs = args.idleMs ?? (session.model ? pickStreamIdleMs(session.model) : 60_000);

	await runWithFallback(session, message, {
		fallbacks,
		wrapAttempt: (promptFn) =>
			runWithHeartbeat(
				session,
				() =>
					runWithStreamTimeout(
						session,
						() =>
							runWithLengthContinuation(
								session,
								() =>
									runWithContentQualityRetry(
										session,
										() =>
											runWithThinkingFallback(session, promptFn, {
												onDowngrade: (originalLevel) => {
													emitAgentEvent({
														type: "turn-thinking-downgrade",
														runId,
														from: String(originalLevel),
													});
												},
											}),
										{
											onRetry: (reason) => {
												emitAgentEvent({
													type: "turn-content-retry",
													runId,
													// Cast — runWithContentQualityRetry's `reason`
													// is the same string set as our event field.
													reason: reason as
														| "empty"
														| "reasoning-only"
														| "planning-only",
												});
											},
										},
									),
								{
									onContinue: () => {
										emitAgentEvent({
											type: "turn-length-continue",
											runId,
										});
									},
								},
							),
						{
							idleMs,
							onTimeout: (ms) => {
								emitAgentEvent({
									type: "turn-stream-timeout",
									runId,
									idleMs: ms,
								});
							},
						},
					),
				{
					intervalMs: heartbeatIntervalMs,
					onHeartbeat: (ms) => {
						emitAgentEvent({
							type: "turn-heartbeat",
							runId,
							elapsedMs: ms,
						});
					},
				},
			),
		onFallback: (reason: string) => {
			const next = fallbacks[0]?.model;
			emitAgentEvent({
				type: "turn-fallback-attempt",
				runId,
				reason,
				toProvider: next?.provider,
				toModelId: next?.id,
			});
		},
		onFallbackExhausted: (reason: string) => {
			emitAgentEvent({
				type: "turn-fallback-exhausted",
				runId,
				reason,
			});
		},
		retryPolicy: {
			onRetry: (info: { class?: string; reason?: string }) => {
				emitAgentEvent({
					type: "turn-retry-attempt",
					runId,
					errorClass: String(info.class ?? "unknown"),
					reason: String(info.reason ?? ""),
				});
			},
			onCompactBeforeRetry: () => {
				emitAgentEvent({ type: "turn-compact-before-retry", runId });
			},
		},
	});
}
