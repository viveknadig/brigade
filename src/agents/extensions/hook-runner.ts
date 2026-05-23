/**
 * Brigade hook runner — the 4-pattern dispatcher behind `registry.fireHook(...)`.
 *
 * Pi's native `pi.on(event, handler)` fires handlers sequentially in registration
 * order and discards their return values — fine for telemetry, useless for the
 * shapes the rest of Brigade needs (modifying payloads, claiming an inbound,
 * write-path mutators). This runner adds Brigade's own ordering + four explicit
 * patterns on top, keyed by hook NAME (not by handler), so a handler authored
 * once via `b.hook(...)` gets the right dispatch shape automatically:
 *
 *   - `"void"`     — every handler runs in parallel via Promise.all; errors are
 *                    swallowed; no return value. Telemetry-only.
 *                    (`turn_start`, `agent_end`, `message_sent`, …)
 *   - `"modifying"`— sequential by priority; each handler may return
 *                    `{ modifications, shouldStop }`. Modifications shallow-merge
 *                    into the payload so downstream handlers see the patched
 *                    view; `shouldStop: true` halts the chain after the merge.
 *                    (`before_prompt_build`, `message_sending`, …)
 *   - `"claiming"` — sequential; the first handler to return `{ handled: true }`
 *                    wins and the rest are skipped. Returns `{ handled, by }` so
 *                    the caller can log which handler took it. Used wherever ONE
 *                    plugin must own the event (`inbound_claim`, `reply_dispatch`).
 *   - `"sync"`     — sequential SYNCHRONOUS; if a handler returns a Promise the
 *                    runner THROWS pointing to the handler index. For write-path
 *                    mutators that MUST complete before the next operation runs
 *                    (`tool_result_persist`, `before_message_write`).
 *
 * The runner is payload-agnostic: it never inspects the shape beyond merging
 * `modifications`. Each consumer site decides what the payload contains.
 */

import type { HookExecutionPattern, HookRegistration, HookResult } from "./types.js";

/** Brigade-native hook name registry. New events plug in here + HOOK_PATTERNS. */
export type BrigadeHookName =
	| "turn_start"
	| "turn_end"
	| "agent_start"
	| "agent_end"
	| "before_prompt_build"
	| "before_model_resolve"
	| "inbound_claim"
	| "before_dispatch"
	| "reply_dispatch"
	| "before_agent_reply"
	| "message_received"
	| "message_sending"
	| "message_sent"
	| "tool_result_persist"
	| "before_message_write"
	| "subagent_spawning"
	| "subagent_spawned"
	| "subagent_ended"
	| "before_install";

/** Dispatch pattern for every Brigade-native hook. */
export const HOOK_PATTERNS: Record<BrigadeHookName, HookExecutionPattern> = {
	turn_start: "void",
	turn_end: "void",
	agent_start: "void",
	agent_end: "void",
	before_prompt_build: "modifying",
	before_model_resolve: "modifying",
	inbound_claim: "claiming",
	before_dispatch: "claiming",
	reply_dispatch: "claiming",
	before_agent_reply: "claiming",
	message_received: "void",
	message_sending: "modifying",
	message_sent: "void",
	tool_result_persist: "sync",
	before_message_write: "sync",
	subagent_spawning: "modifying",
	subagent_spawned: "void",
	subagent_ended: "void",
	before_install: "modifying",
};

/**
 * Result of a `fire(...)` dispatch. Always carries a `handlerCount` (how many
 * handlers MATCHED this event — useful for logs / dead-event detection) plus the
 * pattern-specific outcome:
 *   - void   → just `{ handlerCount }`
 *   - modify → final `{ modifications }` (the merged payload patch)
 *   - claim  → `{ handled, by? }`
 *   - sync   → just `{ handlerCount }`
 */
export interface HookFireResult extends HookResult {
	handlerCount: number;
	/** Handler index (0-based, post-sort) that claimed the event — claiming pattern only. */
	by?: number;
}

/** A handler entry the runner accepts. `id` is optional (for `by` reporting). */
export interface RunnerHandlerEntry {
	handler: (payload: unknown) => unknown;
	priority?: number;
	id?: string | number;
}

/**
 * Build a runner over a fixed handler set. The set is sorted once (higher
 * priority first; ties keep insertion order) so repeated `fire(...)` calls
 * don't re-sort. Callers that mutate the underlying set should build a new
 * runner.
 */
export function createHookRunner(handlers: ReadonlyArray<RunnerHandlerEntry>): {
	fire: (name: BrigadeHookName, payload: unknown) => Promise<HookFireResult>;
} {
	// Stable sort: decorate with index so equal priorities keep registration order.
	const sorted = handlers
		.map((h, i) => ({ h, i }))
		.sort((a, b) => (b.h.priority ?? 0) - (a.h.priority ?? 0) || a.i - b.i)
		.map((x) => x.h);

	return {
		async fire(name, payload) {
			const pattern = HOOK_PATTERNS[name];
			if (!pattern) {
				// Defensive: BrigadeHookName is a closed union so TS catches typos at
				// compile time, but JS callers (or a future name added without a
				// pattern entry) would land here. Treat as void so the call still
				// completes, but surface a clear error to make the gap obvious.
				throw new Error(`hook-runner: unknown hook name "${String(name)}" — add it to HOOK_PATTERNS`);
			}

			const count = sorted.length;

			if (pattern === "void") {
				// Parallel, errors swallowed — telemetry must never break the turn.
				await Promise.all(
					sorted.map(async (h) => {
						try {
							await h.handler(payload);
						} catch {
							/* swallow */
						}
					}),
				);
				return { handlerCount: count };
			}

			if (pattern === "modifying") {
				let merged: Record<string, unknown> = {};
				for (const h of sorted) {
					let res: HookResult | undefined;
					try {
						res = (await h.handler(payload)) as HookResult | undefined;
					} catch {
						// Modifying handlers that throw are skipped — same isolation as void;
						// a busted handler must not block the chain.
						continue;
					}
					if (res && typeof res === "object") {
						if (res.modifications && typeof res.modifications === "object") {
							merged = { ...merged, ...res.modifications };
							// Shallow-merge live into the payload so subsequent handlers see the patched view.
							if (payload && typeof payload === "object") {
								Object.assign(payload as Record<string, unknown>, res.modifications);
							}
						}
						if (res.shouldStop) break;
					}
				}
				return { handlerCount: count, modifications: merged };
			}

			if (pattern === "claiming") {
				for (let i = 0; i < sorted.length; i++) {
					const h = sorted[i]!;
					let res: HookResult | undefined;
					try {
						res = (await h.handler(payload)) as HookResult | undefined;
					} catch {
						// A throwing claim handler does NOT claim — fall through to the next.
						continue;
					}
					if (res && res.handled === true) {
						return { handlerCount: count, handled: true, by: i };
					}
				}
				return { handlerCount: count, handled: false };
			}

			// pattern === "sync"
			// Sequential synchronous. Returning a Promise from a sync handler is a
			// programming error — these are write-path mutators that must complete
			// before the next operation. Throw with the offending index so the
			// author can find it.
			for (let i = 0; i < sorted.length; i++) {
				const h = sorted[i]!;
				const out = h.handler(payload);
				if (out && typeof (out as { then?: unknown }).then === "function") {
					throw new Error(
						`hook-runner: sync hook "${name}" handler at index ${i} returned a Promise — sync handlers must be synchronous`,
					);
				}
			}
			return { handlerCount: count };
		},
	};
}

/** Build a runner from the registry's recorded `HookRegistration[]` shape. */
export function runnerFromRegistrations(
	regs: ReadonlyArray<HookRegistration>,
): ReturnType<typeof createHookRunner> {
	return createHookRunner(
		regs.map((r) => ({
			handler: r.handler as (p: unknown) => unknown,
			priority: r.priority,
			id: r.event,
		})),
	);
}
