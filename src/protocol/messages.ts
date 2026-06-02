/**
 * Wire-level message envelope union (Step 24).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/protocol/schema/frames.ts`.
 * Defines the FOUR top-level frame shapes that travel over the gateway
 * WebSocket (or any in-process equivalent transport):
 *
 *   - `req`   — request from client to server with method + params + id
 *   - `res`   — response from server to client with ok + payload | error
 *   - `event` — server-pushed event with stream name + payload + seq
 *   - `tick`  — server keepalive carrying timestamp (for stall detection)
 *
 * Brigade's `gateway-call.ts` (Step 18) consumes these types through the
 * `GatewayCaller` interface; this file is the schema-level source of truth.
 *
 * Naming + shape match upstream verbatim so the dev-tools network panel
 * is portable between OC and Brigade reference traces.
 */

/** Structured error returned in `res.error`. */
export interface ProtocolErrorShape {
	code: string;
	message: string;
	details?: unknown;
	retryable?: boolean;
	retryAfterMs?: number;
}

/** Client → server: request a method invocation. */
export interface RequestFrame {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
}

/** Server → client: paired response to a request. */
export interface ResponseFrame {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: ProtocolErrorShape;
}

/** Server → client: pushed event with optional seq + state-version. */
export interface EventFrame {
	type: "event";
	event: string;
	payload?: unknown;
	seq?: number;
	stateVersion?: StateVersion;
}

/** Server → client: low-cost keepalive carrying server timestamp. */
export interface TickFrame {
	type: "tick";
	ts: number;
}

/** Server → client: graceful shutdown notice. */
export interface ShutdownFrame {
	type: "shutdown";
	reason: string;
	restartExpectedMs?: number;
}

/** Discriminated union of every top-level frame. */
export type GatewayFrame =
	| RequestFrame
	| ResponseFrame
	| EventFrame
	| TickFrame
	| ShutdownFrame;

/** Optional state-version carried on event frames (clients can detect drift). */
export interface StateVersion {
	domain: string;
	version: number;
}
