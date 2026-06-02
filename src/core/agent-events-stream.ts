/**
 * Agent-event → WebSocket fan-out (Step 25).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/server-broadcast.ts`
 * fan-out pattern, scoped to Brigade's current needs. Bridges Step 18's
 * in-process `onAgentEvent` listener bus to the gateway's per-connection
 * subscribers.
 *
 * Architecture (mirrored from upstream):
 *
 *   - Each connected client owns a `connId`.
 *   - Per-event subscriptions: a client opts into a stream by `connId`.
 *   - Broadcast: when an event fires, only subscribers AND scope-eligible
 *     clients receive a copy.
 *   - Slow-consumer protection: if a client's outbound buffer exceeds the
 *     policy ceiling, the broadcast is either dropped (for
 *     drop-if-slow streams like deltas) or the connection is force-closed
 *     (for must-deliver streams). The Brigade fan-out today only
 *     implements the drop policy; force-close lands when the actual
 *     WebSocket server arrives.
 *
 * What this file IS:
 *
 *   - `BroadcastTarget` — the interface every transport adapter
 *     implements (WS today, in-memory pipe for tests).
 *   - `attachAgentEventBroadcast` — wires `onAgentEvent` to the target.
 *   - `subscribeStream` / `unsubscribeStream` / `subscribeSessionMessages`
 *     — per-connection subscription registry.
 *
 * What this file is NOT:
 *
 *   - Not the HTTP/WS server itself (Brigade ships that separately).
 *   - Not the auth/scope check (lives at the per-method handler).
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { onAgentEvent } from "../agents/agent-events.js";
import type { AgentEventPayload, AgentEventStream } from "../agents/agent-events.types.js";

const log = createSubsystemLogger("core/agent-events-stream");

export interface BroadcastTarget {
	/**
	 * Send a single frame to a specific connection. Implementations are
	 * expected to fast-fail on closed/slow connections; the bus
	 * suppresses + logs throws.
	 */
	sendToConn: (connId: string, frame: unknown) => void;
	/** Optional: query current buffered-bytes for slow-consumer detection. */
	bufferedAmountForConn?: (connId: string) => number;
}

type ConnSubscriptions = {
	streams: Set<AgentEventStream>;
	sessionMessages: Set<string>;
};

type AgentEventStreamState = {
	subscribers: Map<string, ConnSubscriptions>;
	disposeListener: (() => void) | null;
	target: BroadcastTarget | null;
};

const AGENT_EVENT_STREAM_STATE_KEY = Symbol.for("brigade.agentEventsStream.state");

function createState(): AgentEventStreamState {
	return { subscribers: new Map(), disposeListener: null, target: null };
}

function getState(): AgentEventStreamState {
	return resolveGlobalSingleton<AgentEventStreamState>(AGENT_EVENT_STREAM_STATE_KEY, createState);
}

function getOrCreateSubs(connId: string): ConnSubscriptions {
	const state = getState();
	const existing = state.subscribers.get(connId);
	if (existing) return existing;
	const created: ConnSubscriptions = {
		streams: new Set(),
		sessionMessages: new Set(),
	};
	state.subscribers.set(connId, created);
	return created;
}

/**
 * Subscribe a connection to an event stream. Returns a disposer that
 * removes the subscription (idempotent — calling twice is a no-op).
 */
export function subscribeStream(connId: string, stream: AgentEventStream): () => void {
	if (!connId) return () => {};
	const subs = getOrCreateSubs(connId);
	subs.streams.add(stream);
	return () => {
		const s = getState().subscribers.get(connId);
		if (!s) return;
		s.streams.delete(stream);
		if (s.streams.size === 0 && s.sessionMessages.size === 0) {
			getState().subscribers.delete(connId);
		}
	};
}

/**
 * Subscribe a connection to message events for a SPECIFIC session.
 * Independent of stream subscription — a client can subscribe to
 * `lifecycle` events globally AND per-session message events.
 */
export function subscribeSessionMessages(connId: string, sessionKey: string): () => void {
	if (!connId || !sessionKey) return () => {};
	const subs = getOrCreateSubs(connId);
	subs.sessionMessages.add(sessionKey);
	return () => {
		const s = getState().subscribers.get(connId);
		if (!s) return;
		s.sessionMessages.delete(sessionKey);
		if (s.streams.size === 0 && s.sessionMessages.size === 0) {
			getState().subscribers.delete(connId);
		}
	};
}

/** Remove every subscription for a connection (call on disconnect). */
export function removeConn(connId: string): void {
	if (!connId) return;
	getState().subscribers.delete(connId);
}

/**
 * Snapshot the conn ids subscribed to a particular stream. Used by
 * targeted broadcasts that go to a specific subset (e.g. "every client
 * subscribed to `session-message` events for session X").
 */
export function listSubscribersForStream(stream: AgentEventStream): string[] {
	const out: string[] = [];
	for (const [connId, subs] of getState().subscribers) {
		if (subs.streams.has(stream)) out.push(connId);
	}
	return out;
}

export function listSubscribersForSessionMessages(sessionKey: string): string[] {
	const out: string[] = [];
	for (const [connId, subs] of getState().subscribers) {
		if (subs.sessionMessages.has(sessionKey)) out.push(connId);
	}
	return out;
}

/**
 * Wire `onAgentEvent` into the broadcast target. Idempotent: a subsequent
 * `attachAgentEventBroadcast` call replaces the previous target + disposes
 * the previous listener (useful for SIGUSR1 / config reload).
 *
 * Returns a disposer that unwires the listener.
 */
export function attachAgentEventBroadcast(target: BroadcastTarget): () => void {
	const state = getState();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}
	state.target = target;
	state.disposeListener = onAgentEvent((event) => {
		try {
			fanOut(event, target);
		} catch (err) {
			log.warn("agent-event fan-out threw", {
				stream: event.stream,
				runId: event.runId,
				error: (err as Error)?.message,
			});
		}
	});
	return () => {
		if (state.disposeListener) {
			state.disposeListener();
			state.disposeListener = null;
		}
		state.target = null;
	};
}

function fanOut(event: AgentEventPayload, target: BroadcastTarget): void {
	const frame = {
		type: "event" as const,
		event: event.stream,
		payload: event,
		seq: event.seq,
	};
	// Stream-level subscribers (all events of `stream` kind).
	for (const connId of listSubscribersForStream(event.stream)) {
		try {
			target.sendToConn(connId, frame);
		} catch (err) {
			log.warn("event send threw", { connId, error: (err as Error)?.message });
		}
	}
}

/** Test-only — drop every subscription + dispose the bus listener. */
export function resetAgentEventsStreamForTests(): void {
	const state = getState();
	state.subscribers.clear();
	if (state.disposeListener) {
		state.disposeListener();
		state.disposeListener = null;
	}
	state.target = null;
}
