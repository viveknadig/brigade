/**
 * `EmbeddedChatClient` — `ChatClient` backed by an in-process Pi
 * `AgentSession`.
 *
 * Used by `brigade chat` (the in-process TUI). Wraps a long-lived Pi
 * session so the TUI can call `client.X` instead of `session.X`. Most
 * methods are passthrough; the only added value is:
 *
 *   1. Type narrowing — Pi's `Model<any>` becomes `Model<Api>` on the
 *      ChatClient interface, so the TUI gets stricter typing without
 *      Pi having to change.
 *
 *   2. `subscribe` returns an idempotent disposer (Pi's already does,
 *      but we wrap to make the contract explicit).
 *
 *   3. `steer` translates the structured `{text, images}` shape into
 *      Pi's positional `(text, images)` signature.
 *
 * The session is created and configured BEFORE this client is built —
 * by `buildAgent` (Runtime A entry today, Phase 5 will collapse onto
 * the same hardened path). The wrapper does NOT own the session
 * lifecycle; the caller is responsible for `dispose()` on shutdown.
 *
 * For the gateway path, a sibling `GatewayChatClient` (in
 * `cli/commands/connect.ts`) implements the same interface over
 * WebSocket. Both can be passed to `runChat` interchangeably.
 */

import { randomUUID } from "node:crypto";

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import { runBrigadeTurnLoop } from "./brigade-turn-loop.js";
import { switchModelMidTurn as piSwitchModelMidTurn } from "./mid-turn-switch.js";
import type {
	ChatClient,
	ChatThinkingLevel,
	SteerOptions,
	Unsubscribe,
} from "./chat-client.js";

export interface EmbeddedChatClientOptions {
	/** A Pi `AgentSession`, fully constructed (auth + model + system
	 *  prompt + tool guards already applied). */
	session: AgentSession;
}

/**
 * Wrap an existing Pi `AgentSession` as a `ChatClient`. The session
 * stays long-lived — every `prompt` call reuses it. JSONL transcript
 * continuity, compaction, model switching all happen in-place.
 */
export function makeEmbeddedChatClient(opts: EmbeddedChatClientOptions): ChatClient {
	const { session } = opts;

	return {
		// ── Read-only metadata ────────────────────────────────────────

		get messages() {
			return session.messages;
		},

		get model() {
			return session.model ?? null;
		},

		get thinkingLevel() {
			return session.thinkingLevel as ChatThinkingLevel;
		},

		supportsThinking() {
			return session.supportsThinking();
		},

		getAvailableThinkingLevels() {
			return session.getAvailableThinkingLevels() as readonly ChatThinkingLevel[];
		},

		// ── Streaming events ──────────────────────────────────────────

		subscribe(handler): Unsubscribe {
			const detach = session.subscribe(handler);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				try {
					detach();
				} catch {
					// session may already be torn down; harmless.
				}
			};
		},

		// ── Turn control ──────────────────────────────────────────────

		async prompt(
			text: string,
			opts?: { signal?: AbortSignal; fallbacks?: Array<{ model: Model<Api> }> },
		): Promise<void> {
			// Pi's `prompt` doesn't accept an AbortSignal — the way to
			// cancel mid-stream is `session.abort()`. We bridge by
			// wiring a one-shot signal listener that calls abort when
			// the caller's signal fires.
			let onAbort: (() => void) | undefined;
			if (opts?.signal) {
				if (opts.signal.aborted) {
					await session.abort().catch(() => undefined);
					return;
				}
				onAbort = () => {
					session.abort().catch(() => undefined);
				};
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			try {
				// `runBrigadeTurnLoop` owns the 6-layer wrapper composition
				// (fallback → heartbeat → stream-timeout → length-continue →
				// content-quality → thinking-fallback → session.prompt). Each
				// layer emits a `turn-*` bus event on its lifecycle callback,
				// so consumers (TUI, gateway WS broadcast) get a single
				// subscription point for every per-turn status update.
				//
				// `runId` is generated per-prompt; lifecycle event subscribers
				// can filter by runId to scope updates to a specific turn.
				// (Pi's own events flow through `buildAgent`'s bus bridge
				// with the per-buildAgent runId — see core/agent.ts.)
				const runId = randomUUID();
				await runBrigadeTurnLoop({
					session,
					runId,
					message: text,
					fallbacks: opts?.fallbacks ?? [],
				});
			} finally {
				if (onAbort && opts?.signal) {
					opts.signal.removeEventListener("abort", onAbort);
				}
			}
		},

		async abort() {
			await session.abort();
		},

		async steer(opts: SteerOptions): Promise<void> {
			// Pi accepts `(text, images?)` positional with each image
			// as `{type: "image", data, mimeType}`. Our public form
			// drops the redundant `type` discriminator and lets the
			// wrapper restore it. We `await` the underlying promise so
			// async errors (invalid encoding, transcript write failure)
			// reach the caller instead of getting silently dropped.
			const images = opts.images?.map((img) => ({
				type: "image" as const,
				data: img.data,
				mimeType: img.mimeType,
			}));
			await session.steer(opts.text, images);
		},

		// ── Configuration mutations ───────────────────────────────────

		async setModel(model) {
			await session.setModel(model);
		},

		async switchModelMidTurn(target, userMessageToReplay) {
			// Delegate to the Pi-deep helper. It handles the abort →
			// setModel → re-prompt sequence atomically; we just pass
			// through the session reference held in this client's
			// closure so the caller doesn't need raw Pi access.
			return piSwitchModelMidTurn(session, target, userMessageToReplay);
		},

		setThinkingLevel(level) {
			session.setThinkingLevel(level);
		},

		// ── Context window ────────────────────────────────────────────

		getContextUsage() {
			return session.getContextUsage();
		},

		// ── Compaction ────────────────────────────────────────────────

		async compact() {
			// Pi returns a `CompactionResult`. ChatClient contract is
			// `Promise<void>` — callers inspect `getContextUsage()`
			// after to see the delta. We discard the result.
			await session.compact();
		},
	};
}
