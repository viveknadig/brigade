/**
 * Normalization + defaulting layer.
 *
 * `ops.add` / `ops.update` take a partial `CronJobCreate` from the caller (CLI,
 * RPC, or agent tool) and the store needs a fully-realised `CronJob` with
 * every field decided. This file owns the defaulting rules so the timer
 * loop, the run log, and the delivery dispatcher can all trust that
 * downstream values are present.
 *
 * Defaulting rules locked from the reference architecture:
 *   - `enabled` defaults to `true`.
 *   - `wakeMode` defaults to `"next-heartbeat"` (less disruptive than `"now"`).
 *   - `deleteAfterRun` defaults to `true` for `kind: "at"`, undefined otherwise.
 *   - `sessionTarget` defaults to `"main"` for `systemEvent` payloads,
 *     `"isolated"` for `agentTurn` payloads.
 *   - `delivery.mode` defaults: `"none"` for `systemEvent`, `"announce"` for
 *     `agentTurn` (so the operator sees the result by default).
 *   - `delivery.bestEffort` defaults to `false`.
 *   - Top-of-hour `cron` patterns get a 5-minute stagger window unless
 *     explicit.
 *
 * Validation calls live in `service/jobs.ts:assertSupportedJobSpec`; this
 * file only fills defaults + light coercion.
 */

import { defaultStaggerMsForCronExpression } from "./stagger.js";
import type {
	CronDelivery,
	CronJobCreate,
	CronPayload,
	CronSchedule,
	CronSessionTarget,
	CronWakeMode,
} from "./types.js";

/** Default sessionTarget given a payload's kind. */
export function defaultSessionTargetForPayload(payload: CronPayload): CronSessionTarget {
	return payload.kind === "systemEvent" ? "main" : "isolated";
}

/** Default delivery mode given the payload's kind. */
function defaultDeliveryModeForPayload(payload: CronPayload): CronDelivery["mode"] {
	return payload.kind === "systemEvent" ? "none" : "announce";
}

/**
 * Coerce a permissive caller-supplied schedule into a canonical `CronSchedule`.
 *
 * The agent tool's TypeBox shape is `Type.Any()` so the LLM can pass any of:
 *   - a bare string  → `"0 9 * * *"` (treated as a cron expression)
 *   - a record missing `kind` but carrying `expr` / `cron` / `everyMs` / `at`
 *   - the canonical `{kind: "cron", expr: "..."}` shape
 *
 * Without this coercion a string slipped past `normalizeSchedule` unchanged,
 * landed on disk with no `kind`, and `computeNextRunAtMs`'s switch returned
 * `undefined` forever — the job never fired. Migration of already-stored
 * bad-shape schedules happens in `store.ts:ensureLoaded` using this same
 * helper, so an operator who hit the bug on an older build doesn't have to
 * hand-edit `~/.brigade/cron.json`.
 */
export function coerceScheduleInput(raw: unknown): CronSchedule {
	if (typeof raw === "string") {
		const expr = raw.trim();
		if (!expr) throw new Error("cron schedule string is empty");
		return { kind: "cron", expr };
	}
	if (raw === null || typeof raw !== "object") {
		throw new Error(
			"cron schedule must be a string (cron expr) or an object — got " + typeof raw,
		);
	}
	const rec = raw as Record<string, unknown>;
	const rawKind = typeof rec.kind === "string" ? rec.kind.toLowerCase() : undefined;
	const validKinds = new Set(["at", "every", "cron"]);
	const kind = rawKind && validKinds.has(rawKind) ? rawKind : undefined;
	// Pull expression out of either `expr` or the legacy `cron` alias.
	const rawExpr =
		typeof rec.expr === "string"
			? rec.expr
			: typeof rec.cron === "string"
				? rec.cron
				: undefined;
	const expr = rawExpr?.trim() || undefined;
	const everyMs = typeof rec.everyMs === "number" ? rec.everyMs : undefined;
	// Accept `at` OR `atMs` as the absolute timestamp field. Some models (and
	// the older Brigade schema) used `atMs`; the canonical field is `at`. We
	// quietly merge so a model writing either shape lands the same job.
	const at =
		typeof rec.at === "number"
			? rec.at
			: typeof rec.atMs === "number"
				? rec.atMs
				: undefined;
	// Infer kind from whichever discriminator field is present.
	const inferredKind =
		kind ??
		(at !== undefined
			? "at"
			: everyMs !== undefined
				? "every"
				: expr
					? "cron"
					: undefined);
	if (!inferredKind) {
		throw new Error(
			"cron schedule object needs at least one of: kind, expr, everyMs, at",
		);
	}
	switch (inferredKind) {
		case "at": {
			if (at === undefined) {
				throw new Error('cron schedule kind "at" requires a numeric `at` (ms since epoch)');
			}
			return { kind: "at", at };
		}
		case "every": {
			if (everyMs === undefined) {
				throw new Error('cron schedule kind "every" requires a numeric `everyMs`');
			}
			const anchorMs = typeof rec.anchorMs === "number" ? rec.anchorMs : undefined;
			return {
				kind: "every",
				everyMs,
				...(anchorMs !== undefined ? { anchorMs } : {}),
			};
		}
		case "cron": {
			if (!expr) {
				throw new Error('cron schedule kind "cron" requires `expr` (a cron expression)');
			}
			const tz = typeof rec.tz === "string" ? rec.tz : undefined;
			const staggerMs = typeof rec.staggerMs === "number" ? rec.staggerMs : undefined;
			return {
				kind: "cron",
				expr,
				...(tz !== undefined ? { tz } : {}),
				...(staggerMs !== undefined ? { staggerMs } : {}),
			};
		}
	}
	throw new Error(`cron schedule has unsupported kind: ${inferredKind}`);
}

/**
 * Fill in a schedule's optional fields. For `cron` kind, applies the
 * top-of-hour stagger default. Other kinds pass through unchanged.
 *
 * Always run AFTER `coerceScheduleInput` — accepts only canonical-shape
 * schedules. Stale callers that pass a bare string slip past here unchanged
 * (the type-guard `schedule.kind !== "cron"` is true for `undefined`), so
 * make sure the entry point calls coerce first.
 */
export function normalizeSchedule(schedule: CronSchedule): CronSchedule {
	if (schedule.kind !== "cron") return schedule;
	if (schedule.staggerMs !== undefined) return schedule;
	const stagger = defaultStaggerMsForCronExpression(schedule.expr);
	if (stagger <= 0) return schedule;
	return { ...schedule, staggerMs: stagger };
}

/**
 * Fill in a delivery block's missing fields. Returns `undefined` only if the
 * caller already opted out by omitting delivery AND the payload's natural
 * default is also `none`.
 */
export function normalizeDelivery(
	delivery: CronDelivery | undefined,
	payload: CronPayload,
): CronDelivery | undefined {
	const mode = delivery?.mode ?? defaultDeliveryModeForPayload(payload);
	if (mode === "none" && !delivery) return undefined;
	return {
		mode,
		...(delivery?.channel !== undefined ? { channel: delivery.channel } : {}),
		...(delivery?.to !== undefined ? { to: delivery.to } : {}),
		...(delivery?.accountId !== undefined ? { accountId: delivery.accountId } : {}),
		...(delivery?.threadId !== undefined ? { threadId: delivery.threadId } : {}),
		bestEffort: delivery?.bestEffort ?? false,
		...(delivery?.webhookUrl !== undefined ? { webhookUrl: delivery.webhookUrl } : {}),
	};
}

/** Default wake mode for `wake` actions when the caller didn't specify. */
export function defaultWakeMode(): CronWakeMode {
	return "next-heartbeat";
}

/**
 * Resolve `deleteAfterRun` for a schedule kind. Caller-supplied wins; else
 * one-shot `at` jobs auto-delete on success, recurring jobs do not.
 */
export function resolveDeleteAfterRun(
	caller: boolean | undefined,
	schedule: CronSchedule,
): boolean | undefined {
	if (caller !== undefined) return caller;
	return schedule.kind === "at" ? true : undefined;
}

/**
 * Produce a fully-defaulted create input — every optional field decided.
 * Doesn't validate; that's `assertSupportedJobSpec`'s job. Doesn't write to
 * disk; the caller (ops.add) does that.
 */
export function defaultCronJobCreate(input: CronJobCreate): Required<
	Pick<CronJobCreate, "enabled" | "sessionTarget" | "wakeMode">
> & CronJobCreate {
	// Coerce permissive caller input (bare string / object-without-kind) into
	// the canonical CronSchedule shape BEFORE we touch staggerMs etc. — see
	// `coerceScheduleInput` for the supported shapes.
	const coerced = coerceScheduleInput(input.schedule);
	const schedule = normalizeSchedule(coerced);
	const sessionTarget = input.sessionTarget ?? defaultSessionTargetForPayload(input.payload);
	const wakeMode = input.wakeMode ?? defaultWakeMode();
	const delivery = normalizeDelivery(input.delivery, input.payload);
	const deleteAfterRun = resolveDeleteAfterRun(input.deleteAfterRun, schedule);
	return {
		...input,
		schedule,
		sessionTarget,
		wakeMode,
		enabled: input.enabled ?? true,
		...(delivery !== undefined ? { delivery } : {}),
		...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
	};
}
