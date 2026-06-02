/**
 * `DeliveryContext` — the canonical {channel, accountId, to, threadId}
 * tuple that flows through the runtime whenever a message needs to land
 * somewhere specific.
 *
 * Three consumers:
 *
 *   1. **Cron announce delivery** (`cron/service/timer.ts:maybeDeliverAnnounce`)
 *      — when a cron with `delivery.mode === "announce"` fires, the resolver
 *      builds a `DeliveryContext` from the job's `delivery.channel/to/…`
 *      OR from `lastSeenChannel` fallback OR (for cron-fired from a channel
 *      turn) from the originating `channelContext`.
 *
 *   2. **sessions_send target resolution** — when one session sends to
 *      another, the target session's `lastSeenChannel` is normalised into
 *      a `DeliveryContext` so the receiving turn knows where its reply
 *      should land.
 *
 *   3. **SessionContext routing** — the per-turn capsule carries an
 *      origin `DeliveryContext` so tools that need to "reply to where
 *      this came from" can read one shape.
 *
 * `normalizeDeliveryContext` parses a possibly-loose record (e.g. from
 * a cron job's persisted JSON) into the canonical shape, dropping invalid
 * / empty fields. `mergeDeliveryContext` overlays a partial update onto
 * a base context (later fields win for keys they specify).
 */

import {
	type GatewayMessageChannel,
	normalizeMessageChannel,
} from "./message-channel.js";
import { normalizeOptionalString } from "./string-coerce.js";

export interface DeliveryContext {
	channel?: GatewayMessageChannel;
	accountId?: string;
	to?: string;
	threadId?: string | number;
}

/**
 * Coerce a loose record into a canonical `DeliveryContext`. Drops fields
 * that don't survive normalisation (empty strings, wrong types). Returns
 * an empty object (NOT undefined) when nothing valid — callers can chain
 * `mergeDeliveryContext` without null guards.
 */
export function normalizeDeliveryContext(input: unknown): DeliveryContext {
	if (input === null || typeof input !== "object") return {};
	const record = input as Record<string, unknown>;
	const out: DeliveryContext = {};

	const channel = normalizeMessageChannel(record.channel);
	if (channel !== undefined) out.channel = channel;

	const accountId = normalizeOptionalString(record.accountId);
	if (accountId !== undefined) out.accountId = accountId;

	const to = normalizeOptionalString(record.to);
	if (to !== undefined) out.to = to;

	const rawThread = record.threadId;
	if (typeof rawThread === "string") {
		const trimmed = rawThread.trim();
		if (trimmed.length > 0) out.threadId = trimmed;
	} else if (typeof rawThread === "number" && Number.isFinite(rawThread)) {
		out.threadId = rawThread;
	}

	return out;
}

/**
 * Merge `update` over `base` — every key in `update` that resolves to a
 * defined value wins. Use to apply a partial override (e.g. cron's
 * `delivery.threadId` override on top of `lastSeenChannel`'s context).
 *
 * Returns a fresh object; the inputs are not mutated.
 */
export function mergeDeliveryContext(
	base: DeliveryContext | undefined,
	update: DeliveryContext | undefined,
): DeliveryContext {
	const merged: DeliveryContext = { ...(base ?? {}) };
	if (update) {
		if (update.channel !== undefined) merged.channel = update.channel;
		if (update.accountId !== undefined) merged.accountId = update.accountId;
		if (update.to !== undefined) merged.to = update.to;
		if (update.threadId !== undefined) merged.threadId = update.threadId;
	}
	return merged;
}
