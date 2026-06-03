/**
 * `sessions_history` agent tool (Step 23).
 *
 * Fetches the sanitised message history of another session. The agent
 * uses this to inspect a sub-agent's progress, debug a sibling's
 * decision, or resume a thread.
 *
 * Sanitisation pipeline:
 *
 *   1. Fetch raw messages via `callGateway("chat.history", ...)`.
 *   2. If `includeTools !== true`, drop tool-call + tool-result rows
 *      via `stripToolMessages` (Step 19).
 *   3. Sanitise each remaining message via `sanitizeHistoryMessage`:
 *      - Drop `details`, `usage`, `cost` (heavy fields).
 *      - Truncate text > 4 KB → `…(truncated)…`.
 *      - Strip image `data` payloads (keep only byte count).
 *      - Apply credential redaction (`redactSensitiveText`).
 *      - Strip `thinkingSignature` from thinking blocks.
 *   4. Enforce the 80 KB JSON envelope cap via
 *      `enforceSessionsHistoryHardCap` — if still over budget, swap in
 *      a placeholder so the tool never blows the wire budget.
 */

import { callGateway } from "../../gateway-call.js";
import {
	checkSessionToolAccess,
	describeSessionsHistoryTool,
	enforceSessionsHistoryHardCap,
	jsonToolResult,
	jsonUtf8Bytes,
	sanitizeHistoryMessage,
	SESSIONS_HISTORY_MAX_BYTES,
	SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
	stripToolMessages,
	ToolInputError,
	type AgentToAgentPolicy,
	type SessionToolsVisibility,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsHistoryToolArgs {
	sessionKey: string;
	limit?: number;
	includeTools?: boolean;
}

export interface SessionsHistoryToolOptions {
	agentSessionKey?: string;
	/** Visibility scope for the caller's session: self/tree/agent/all. */
	visibility?: SessionToolsVisibility;
	/** A2A policy resolved from `cfg.session.agentToAgent`. */
	a2aPolicy?: AgentToAgentPolicy;
	/** Session keys the caller (transitively) spawned — used for tree-scope. */
	spawnedKeys?: ReadonlySet<string>;
	/**
	 * Fail-closed opt-out — set to true ONLY for trusted internal pathways
	 * (boot wiring, cron lane, heartbeat). Channel adapters and the model
	 * surface MUST leave this unset so unwired bundles refuse traffic by
	 * default.
	 */
	bypassAccessGuard?: boolean;
}

export interface SessionsHistoryToolDescriptor {
	name: "sessions_history";
	displaySummary: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: SessionsHistoryToolArgs) => Promise<ToolResultEnvelope>;
}

const SESSIONS_HISTORY_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["sessionKey"],
	properties: {
		sessionKey: { type: "string", minLength: 1 },
		limit: { type: "number", minimum: 1, maximum: 500 },
		includeTools: { type: "boolean" },
	},
	additionalProperties: false,
};

function coerceArgs(args: unknown): SessionsHistoryToolArgs {
	if (!args || typeof args !== "object") {
		throw new ToolInputError("sessions_history requires an object argument");
	}
	const obj = args as Record<string, unknown>;
	const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey.trim() : "";
	if (!sessionKey) throw new ToolInputError("sessions_history requires `sessionKey`");
	return {
		sessionKey,
		limit: typeof obj.limit === "number" ? obj.limit : undefined,
		includeTools: typeof obj.includeTools === "boolean" ? obj.includeTools : false,
	};
}

export function createSessionsHistoryTool(
	opts: SessionsHistoryToolOptions = {},
): SessionsHistoryToolDescriptor {
	return {
		name: "sessions_history",
		displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsHistoryTool(),
		parameters: SESSIONS_HISTORY_SCHEMA,
		execute: async (args) => {
			const parsed = coerceArgs(args);
			// Access guard — fail-closed. An unwired bundle (missing caller
			// key OR visibility OR A2A policy) refuses every call; trusted
			// internal pathways opt out via `bypassAccessGuard: true`.
			if (opts.bypassAccessGuard !== true) {
				if (!opts.agentSessionKey || !opts.visibility || !opts.a2aPolicy) {
					return jsonToolResult({
						status: "forbidden",
						sessionKey: parsed.sessionKey,
						error:
							"sessions_history forbidden: session access policy not configured",
					});
				}
				const access = checkSessionToolAccess({
					action: "history",
					requesterSessionKey: opts.agentSessionKey,
					targetSessionKey: parsed.sessionKey,
					visibility: opts.visibility,
					a2aPolicy: opts.a2aPolicy,
					...(opts.spawnedKeys ? { spawnedKeys: opts.spawnedKeys } : {}),
				});
				if (!access.allowed) {
					return jsonToolResult({
						status: "forbidden",
						sessionKey: parsed.sessionKey,
						error: access.error,
					});
				}
			}
			let raw: { messages?: unknown[] };
			try {
				raw = await callGateway<{ messages?: unknown[] }>({
					method: "sessions.history",
					params: {
						sessionKey: parsed.sessionKey,
						limit: parsed.limit,
					},
					timeoutMs: 10_000,
				});
			} catch (err) {
				return jsonToolResult({
					status: "error",
					sessionKey: parsed.sessionKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			const rawMessages = Array.isArray(raw?.messages) ? raw.messages : [];
			const selected = parsed.includeTools ? rawMessages : stripToolMessages(rawMessages);
			const sanitized = selected.map((message) => sanitizeHistoryMessage(message));
			let contentTruncated = false;
			let contentRedacted = false;
			let droppedMessages = false;
			for (const item of sanitized) {
				if (item.truncated) contentTruncated = true;
				if (item.redacted) contentRedacted = true;
			}
			let items = sanitized.map((item) => item.message);
			let bytes = jsonUtf8Bytes(items);
			const capped = enforceSessionsHistoryHardCap({
				items,
				bytes,
				maxBytes: SESSIONS_HISTORY_MAX_BYTES,
			});
			if (capped.hardCapped) {
				droppedMessages = true;
				items = capped.items;
				bytes = capped.bytes;
			}
			return jsonToolResult({
				sessionKey: parsed.sessionKey,
				messages: items,
				truncated: contentTruncated || droppedMessages,
				droppedMessages,
				contentTruncated,
				contentRedacted,
				bytes,
			});
		},
	};
}
