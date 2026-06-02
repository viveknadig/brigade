/**
 * Per-session system-event inbox.
 *
 * Brand-scrubbed verbatim lift of upstream's `src/infra/system-events.ts`.
 * Lightweight, in-memory, ephemeral queue of human-readable events that
 * the next turn for a session prefixes onto the prompt. Persistence is
 * intentionally NOT supported — events are wake-up signals, not history.
 *
 * Producers (planned):
 *   - Channel manager (Step 16) → inbound messages while a turn is busy
 *   - Cron service (later) → fired-job reminders + payloads
 *   - Sub-agent completion handler (Step 20) → child-result notifications
 *   - Approval router (Step 17) → operator decisions on tool gates
 *   - Heartbeat layer (Steps 13-14) → wake signals scoped per session
 *
 * Consumer (always one):
 *   - The session's main turn loop, which calls `drainSystemEventEntries`
 *     before composing the next user message.
 *
 * Concurrency:
 *   - Map is a global singleton, shared across the gateway process.
 *   - Mutations are NOT lock-guarded; producers run on the JS event loop
 *     and the consumer drains under the per-session lane lock that
 *     `command-queue.ts` already enforces, so the only "drain mid-write"
 *     race is one producer racing one drainer — and the drainer atomically
 *     snapshots-then-truncates so the worst case is "next call sees the
 *     latecomer".
 *   - 20-event soft cap per session (oldest dropped) prevents a runaway
 *     producer from starving memory.
 *   - Consecutive identical `text` is suppressed (returns `false` from
 *     `enqueueSystemEvent`) so a noisy producer can't fill the queue with
 *     duplicates.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	normalizeOptionalLowercaseString,
	normalizeOptionalString,
} from "../shared/string-coerce.js";
import { mergeDeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export type SystemEvent = {
	text: string;
	ts: number;
	contextKey?: string | null;
	deliveryContext?: DeliveryContext;
	trusted?: boolean;
};

const MAX_EVENTS = 20;

type SessionQueue = {
	queue: SystemEvent[];
	lastText: string | null;
	lastContextKey: string | null;
};

const SESSION_INBOX_QUEUES_KEY = Symbol.for("brigade.sessionInbox.queues");

const queues = resolveGlobalSingleton<Map<string, SessionQueue>>(
	SESSION_INBOX_QUEUES_KEY,
	() => new Map<string, SessionQueue>(),
);

type SystemEventOptions = {
	sessionKey: string;
	contextKey?: string | null;
	deliveryContext?: DeliveryContext;
	trusted?: boolean;
};

function requireSessionKey(key?: string | null): string {
	const trimmed = normalizeOptionalString(key) ?? "";
	if (!trimmed) {
		throw new Error("system events require a sessionKey");
	}
	return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
	return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
	return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
	const key = requireSessionKey(sessionKey);
	const existing = queues.get(key);
	if (existing) return existing;
	const created: SessionQueue = {
		queue: [],
		lastText: null,
		lastContextKey: null,
	};
	queues.set(key, created);
	return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
	return {
		...event,
		...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
	};
}

/**
 * `true` iff `contextKey` differs from the most-recently-enqueued event's
 * key for this session. Used by producers that want to suppress a follow-up
 * notification when the operator is still inside the same logical context
 * (e.g. a long-running exec emitting periodic status — only the first
 * status text needs to wake the session).
 */
export function isSystemEventContextChanged(
	sessionKey: string,
	contextKey?: string | null,
): boolean {
	const existing = getSessionQueue(sessionKey);
	const normalized = normalizeContextKey(contextKey);
	return normalized !== (existing?.lastContextKey ?? null);
}

/**
 * Enqueue a human-readable system event for the next turn on `sessionKey`.
 *
 * Returns:
 *   - `true`  → event accepted (queued or replaced a duplicate's metadata)
 *   - `false` → event dropped (empty text OR consecutive duplicate text)
 *
 * Empty-string `text` is dropped silently. Consecutive duplicates by `text`
 * are suppressed so a noisy producer can't flood the queue.
 */
export function enqueueSystemEvent(text: string, options: SystemEventOptions): boolean {
	const key = requireSessionKey(options?.sessionKey);
	const entry = getOrCreateSessionQueue(key);
	const cleaned = text.trim();
	if (!cleaned) return false;
	const normalizedContextKey = normalizeContextKey(options?.contextKey);
	const normalizedDeliveryContext = normalizeDeliveryContext(options?.deliveryContext);
	entry.lastContextKey = normalizedContextKey;
	if (entry.lastText === cleaned) return false;
	entry.lastText = cleaned;
	entry.queue.push({
		text: cleaned,
		ts: Date.now(),
		contextKey: normalizedContextKey,
		deliveryContext: normalizedDeliveryContext,
		trusted: options.trusted !== false,
	});
	if (entry.queue.length > MAX_EVENTS) {
		entry.queue.shift();
	}
	return true;
}

/**
 * Atomic snapshot-and-truncate: returns every queued event for the session
 * in FIFO order and resets the queue.
 *
 * Empty queues return `[]` (NOT `undefined`). The session's queue entry is
 * deleted from the global Map after a successful drain so the registry
 * doesn't grow unbounded under churn.
 */
export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
	const key = requireSessionKey(sessionKey);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0) return [];
	const out = entry.queue.map(cloneSystemEvent);
	entry.queue.length = 0;
	entry.lastText = null;
	entry.lastContextKey = null;
	queues.delete(key);
	return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
	if (!left && !right) return true;
	if (!left || !right) return false;
	return (
		(left.channel ?? undefined) === (right.channel ?? undefined) &&
		(left.to ?? undefined) === (right.to ?? undefined) &&
		(left.threadId ?? undefined) === (right.threadId ?? undefined)
	);
}

function areSystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
	return (
		left.text === right.text &&
		left.ts === right.ts &&
		(left.contextKey ?? null) === (right.contextKey ?? null) &&
		(left.trusted ?? true) === (right.trusted ?? true) &&
		areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
	);
}

/**
 * Partial drain. Removes ONLY the events that match the leading prefix of
 * `consumedEntries` (compared field-wise). If the caller's prefix doesn't
 * match (events arrived out of order, or were already drained), the queue
 * is left intact and `[]` is returned.
 *
 * Used by Step 12's pending-system-events partial drain: the prompt
 * assembler peeks at events, formats them, then consumes the exact set it
 * was about to render — guarantees no event is rendered AND queued at the
 * same time, even under concurrent writes.
 */
export function consumeSystemEventEntries(
	sessionKey: string,
	consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
	const key = requireSessionKey(sessionKey);
	const entry = getSessionQueue(key);
	if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) return [];
	if (
		consumedEntries.length > entry.queue.length ||
		!consumedEntries.every((event, index) => {
			const queued = entry.queue[index];
			return queued !== undefined && areSystemEventsEqual(queued, event);
		})
	) {
		return [];
	}
	const removed = entry.queue.splice(0, consumedEntries.length).map(cloneSystemEvent);
	if (entry.queue.length === 0) {
		entry.lastText = null;
		entry.lastContextKey = null;
		queues.delete(key);
	} else {
		const newest = entry.queue[entry.queue.length - 1];
		if (newest) {
			entry.lastText = newest.text;
			entry.lastContextKey = newest.contextKey ?? null;
		}
	}
	return removed;
}

/** Drain just the text strings (legacy compatible). */
export function drainSystemEvents(sessionKey: string): string[] {
	return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

/** Read-only peek at the queued events for a session. */
export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
	return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

/** Read-only peek at the queued event texts for a session. */
export function peekSystemEvents(sessionKey: string): string[] {
	return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

/** `true` iff the session has at least one queued event. */
export function hasSystemEvents(sessionKey: string): boolean {
	return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

/**
 * Merge the delivery contexts of `events` into a single context. Later
 * events override earlier ones field-by-field. Used by the dispatcher to
 * pick a delivery target when multiple events fired for the same session.
 */
export function resolveSystemEventDeliveryContext(
	events: readonly SystemEvent[],
): DeliveryContext | undefined {
	let resolved: DeliveryContext | undefined;
	for (const event of events) {
		resolved = mergeDeliveryContext(event.deliveryContext, resolved);
	}
	return resolved;
}

/** Test-only — clear every queued event across every session. */
export function resetSessionInboxForTest(): void {
	queues.clear();
}
