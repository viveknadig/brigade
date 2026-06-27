/**
 * Protocol error catalogue (Step 24).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/protocol/schema/error-codes.ts`.
 * Six structured codes cover every condition the gateway responds to —
 * intentionally small so the client-side switch never grows unbounded.
 *
 * Convention: codes are SCREAMING_SNAKE_CASE strings, NOT numbers. The
 * `errorShape(code, message, opts)` helper centralises the construction
 * pattern so every emit site has the same shape.
 */

import type { ProtocolErrorShape } from "./messages.js";

export const ErrorCodes = {
	/** Gateway expected paired-device auth but the request had none. */
	NOT_LINKED: "NOT_LINKED",
	/** Caller is not paired with this gateway yet. */
	NOT_PAIRED: "NOT_PAIRED",
	/** Agent turn timed out — caller may retry with `retryable: true`. */
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	/** Request shape failed validation. */
	INVALID_REQUEST: "INVALID_REQUEST",
	/** Approval lookup by id missed (id never existed or already resolved). */
	APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
	/** Subsystem is loading / draining; caller may retry shortly. */
	UNAVAILABLE: "UNAVAILABLE",
	/**
	 * The remaining codes the gateway actually emits today (previously
	 * undocumented string literals — catalogued here so a web/mobile client has
	 * the COMPLETE, stable set to branch on). Values match the on-the-wire
	 * strings the server already sends.
	 */
	/** Per-connection rate limiter tripped; honour `retryAfterMs`. */
	RATE_LIMITED: "rate-limited",
	/** Unexpected server-side failure handling the request. */
	INTERNAL: "internal",
	/** Caller lacks permission for the target (owner/session gate). */
	FORBIDDEN: "forbidden",
	/** Caller's operator scope is insufficient for this method. */
	SCOPE_INSUFFICIENT: "scope-insufficient",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorShapeOptions {
	details?: unknown;
	retryable?: boolean;
	retryAfterMs?: number;
}

/** Helper to construct a typed `ProtocolErrorShape` from one of the known codes. */
export function errorShape(
	code: ErrorCode,
	message: string,
	opts: ErrorShapeOptions = {},
): ProtocolErrorShape {
	return {
		code,
		message,
		...(opts.details !== undefined ? { details: opts.details } : {}),
		...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
		...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
	};
}
