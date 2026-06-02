/**
 * Per-turn session-context metadata.
 *
 * Brand-scrubbed analogue of upstream's `src/infra/outbound/session-context.ts`
 * (`OutboundSessionContext` + `buildOutboundSessionContext`).
 *
 * Holds the seven small fields every outbound + hook path needs to know
 * which session a payload belongs to, which agent owns it, and where the
 * inbound that triggered the turn came from. The factory is the canonical
 * place to bind a session key to an agent id — every call site that
 * threads context through downstream hooks routes through `buildSessionContext`
 * so the resolution is consistent.
 *
 * What this is NOT:
 *   - Not a state container (no mutation; immutable struct).
 *   - Not the registry handle (see `./session-registry.ts`).
 *   - Not the inbox handle (see `./session-inbox.ts`).
 *   - Not the abort signal carrier (handlers receive `AbortSignal` as a
 *     separate arg per upstream's split).
 *
 * What it IS: the short, JSON-friendly bundle that gets passed to media
 * resolvers, hook handlers, delivery-queue persistence, and outbound
 * routing so they can re-resolve policy decisions without re-parsing the
 * session key or re-walking the bindings tree.
 *
 * Consumed (today + planned):
 *   - Outbound media access resolver (channels): account-scoped policy match
 *   - Delivery-queue storage (channels): crash-safe replay context
 *   - Hook fan-out (Step 18): every hook sees `{ session }` arg
 *   - Gateway dispatcher (Step 25): assembles per-turn context payload
 *   - Cron failure-notification builder (later): re-routes failures to the
 *     originating session
 */

import { resolveAgentIdFromSessionKey } from "./routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

/**
 * Per-turn metadata pinned to one session.
 *
 * All fields are optional individually — the factory returns `undefined`
 * if every field would be empty, so consumers can fail-open on a
 * fully-anonymous context (the dispatcher won't build one for a bound
 * inbound).
 */
export type SessionContext = {
	/** Canonical session key used for internal hook dispatch. */
	key?: string;
	/** Active agent id used for workspace-scoped media roots. */
	agentId?: string;
	/** Originating account id used for requester-scoped group policy resolution. */
	requesterAccountId?: string;
	/** Originating sender id used for sender-scoped outbound media policy. */
	requesterSenderId?: string;
	/** Originating sender display name for name-keyed sender policy matching. */
	requesterSenderName?: string;
	/** Originating sender username for username-keyed sender policy matching. */
	requesterSenderUsername?: string;
	/** Originating sender E.164 phone number for e164-keyed sender policy matching. */
	requesterSenderE164?: string;
};

export interface BuildSessionContextParams {
	sessionKey?: string | null;
	/** Pin a specific agent id. Overrides the agent id derived from `sessionKey`. */
	agentId?: string | null;
	requesterAccountId?: string | null;
	requesterSenderId?: string | null;
	requesterSenderName?: string | null;
	requesterSenderUsername?: string | null;
	requesterSenderE164?: string | null;
}

/**
 * Assemble a `SessionContext` from the loose params the upstream caller
 * has at hand. Returns `undefined` when every field would be empty —
 * lets the caller skip the context-arg entirely for unbound flows.
 *
 * Agent id resolution:
 *   1. `params.agentId` if explicit and non-empty
 *   2. Otherwise, derive from `sessionKey` via `resolveAgentIdFromSessionKey`
 *      (parses `agent:<id>:<rest>` or falls back to the default agent)
 *   3. `undefined` if both are missing
 */
export function buildSessionContext(
	params: BuildSessionContextParams,
): SessionContext | undefined {
	const key = normalizeOptionalString(params.sessionKey);
	const explicitAgentId = normalizeOptionalString(params.agentId);
	const requesterAccountId = normalizeOptionalString(params.requesterAccountId);
	const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
	const requesterSenderName = normalizeOptionalString(params.requesterSenderName);
	const requesterSenderUsername = normalizeOptionalString(params.requesterSenderUsername);
	const requesterSenderE164 = normalizeOptionalString(params.requesterSenderE164);
	const derivedAgentId = key ? resolveAgentIdFromSessionKey(key) : undefined;
	const agentId = explicitAgentId ?? derivedAgentId;
	if (
		!key &&
		!agentId &&
		!requesterAccountId &&
		!requesterSenderId &&
		!requesterSenderName &&
		!requesterSenderUsername &&
		!requesterSenderE164
	) {
		return undefined;
	}
	return {
		...(key ? { key } : {}),
		...(agentId ? { agentId } : {}),
		...(requesterAccountId ? { requesterAccountId } : {}),
		...(requesterSenderId ? { requesterSenderId } : {}),
		...(requesterSenderName ? { requesterSenderName } : {}),
		...(requesterSenderUsername ? { requesterSenderUsername } : {}),
		...(requesterSenderE164 ? { requesterSenderE164 } : {}),
	};
}
