/**
 * `sessions_list` agent tool (Step 22).
 *
 * Enumerates the sessions the caller can see — typically the caller's
 * own session + the sessions it has spawned (transitively). The
 * permission check + visibility resolution lives in Step 19's
 * `checkSessionToolAccess`. The actual session list comes from the
 * gateway via `callGateway("sessions.list", ...)` — Brigade has the
 * registry in-process (Step 11) but the gateway is the canonical surface
 * because cross-process clients (web UI, mobile) also use it.
 *
 * Output shape:
 *
 *   { count, sessions: SessionListRow[] }
 *
 * Each row is the gateway's snapshot — Brigade trims to the small set
 * of fields the agent typically needs (sessionKey, kind, agentId,
 * lastActivityAt, state, label?). The full row (channel, model,
 * tokens, etc.) is available via `sessions_history` if needed.
 */

import { callGateway } from "../../gateway-call.js";
import {
	checkSessionToolAccess,
	describeSessionsListTool,
	jsonToolResult,
	SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
	ToolInputError,
	type AgentToAgentPolicy,
	type SessionToolsVisibility,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsListToolArgs {
	kinds?: string[];
	limit?: number;
	activeMinutes?: number;
	messageLimit?: number;
}

export interface SessionsListToolOptions {
	agentSessionKey?: string;
	/** Sandbox flag — when true, the gateway clamps visibility to spawned. */
	sandboxed?: boolean;
	/** Visibility scope for the caller's session: self/tree/agent/all. */
	visibility?: SessionToolsVisibility;
	/** A2A policy resolved from `cfg.session.agentToAgent`. */
	a2aPolicy?: AgentToAgentPolicy;
	/** Session keys the caller (transitively) spawned — used for tree-scope. */
	spawnedKeys?: ReadonlySet<string>;
	/**
	 * Fail-closed opt-out — true ONLY for trusted internal pathways (boot,
	 * cron, heartbeat). Untrusted callers leave this unset so an unwired
	 * bundle returns zero rows by default instead of surfacing the registry.
	 */
	bypassAccessGuard?: boolean;
}

export interface SessionsListToolDescriptor {
	name: "sessions_list";
	displaySummary: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: SessionsListToolArgs) => Promise<ToolResultEnvelope>;
}

const SESSIONS_LIST_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		kinds: {
			type: "array",
			items: {
				type: "string",
				enum: ["main", "group", "subagent", "cron", "hook", "node", "other"],
			},
		},
		limit: { type: "number", minimum: 1, maximum: 200 },
		activeMinutes: { type: "number", minimum: 1 },
		messageLimit: { type: "number", minimum: 0, maximum: 50 },
	},
	additionalProperties: false,
};

function coerceArgs(args: unknown): SessionsListToolArgs {
	if (args == null) return {};
	if (typeof args !== "object") {
		throw new ToolInputError("sessions_list args must be an object");
	}
	const obj = args as Record<string, unknown>;
	return {
		kinds: Array.isArray(obj.kinds)
			? (obj.kinds.filter((value) => typeof value === "string") as string[])
			: undefined,
		limit: typeof obj.limit === "number" ? obj.limit : undefined,
		activeMinutes: typeof obj.activeMinutes === "number" ? obj.activeMinutes : undefined,
		messageLimit: typeof obj.messageLimit === "number" ? obj.messageLimit : undefined,
	};
}

export function createSessionsListTool(
	opts: SessionsListToolOptions = {},
): SessionsListToolDescriptor {
	return {
		name: "sessions_list",
		displaySummary: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsListTool(),
		parameters: SESSIONS_LIST_SCHEMA,
		execute: async (args) => {
			const parsed = coerceArgs(args);
			// Wave O0.6 — fail-closed early-return. An unwired bundle
			// (missing caller key OR visibility OR A2A policy) refuses
			// every call. Internal trusted callers opt out via
			// `bypassAccessGuard: true`. Previously the per-row filter
			// fell through to the unfiltered `sessions` when any policy
			// field was missing, leaking the full registry to unwired
			// callers.
			if (
				opts.bypassAccessGuard !== true &&
				(!opts.agentSessionKey || !opts.visibility || !opts.a2aPolicy)
			) {
				return jsonToolResult({
					status: "forbidden",
					error: "sessions_list forbidden: session access policy not configured",
					count: 0,
					sessions: [],
				});
			}
			try {
				const result = await callGateway<{
					sessions: Array<Record<string, unknown>>;
					count?: number;
				}>({
					method: "sessions.list",
					params: {
						limit: parsed.limit,
						activeMinutes: parsed.activeMinutes,
						messageLimit: parsed.messageLimit,
						kinds: parsed.kinds,
						// When the caller is sandboxed, gateway filters to
						// `spawnedBy: <caller>` so the tool can't see siblings.
						...(opts.sandboxed && opts.agentSessionKey
							? { spawnedBy: opts.agentSessionKey }
							: {}),
					},
					timeoutMs: 10_000,
				});
				const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
				// Per-row access guard — drop rows the caller is not allowed
				// to see. The gateway's sandbox flag clamps visibility on the
				// server side; this is the tool-side enforcement that also
				// applies to non-sandboxed paths (any caller's tool surface).
				// Skipped only on the trusted-bypass branch (early-return
				// above already refused the unwired-policy case).
				const filtered =
					opts.bypassAccessGuard === true
						? sessions
						: sessions.filter((row) => {
								const targetKey = typeof (row as { sessionKey?: unknown }).sessionKey === "string"
									? ((row as { sessionKey: string }).sessionKey)
									: "";
								if (!targetKey) return true;
								const access = checkSessionToolAccess({
									action: "list",
									requesterSessionKey: opts.agentSessionKey as string,
									targetSessionKey: targetKey,
									visibility: opts.visibility as SessionToolsVisibility,
									a2aPolicy: opts.a2aPolicy as AgentToAgentPolicy,
									...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
								});
								return access.allowed;
							});
				return jsonToolResult({
					count: filtered.length,
					sessions: filtered,
				});
			} catch (err) {
				return jsonToolResult({
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
