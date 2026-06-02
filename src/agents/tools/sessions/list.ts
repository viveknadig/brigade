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
	describeSessionsListTool,
	jsonToolResult,
	SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
	ToolInputError,
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
				return jsonToolResult({
					count: sessions.length,
					sessions,
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
