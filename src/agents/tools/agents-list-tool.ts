/**
 * `agents_list` tool — read-only enumeration of agents the caller may target
 * with `sessions_spawn` (subagent runtime), scoped to the subagent allowlist.
 *
 * Brand-scrubbed port of the reference codebase's
 * `src/agents/tools/agents-list-tool.ts`, adapted to Brigade's keyed-map
 * `cfg.agents` (vs the reference's array `cfg.agents.list`).
 *
 * Contract:
 *
 *   {
 *     requester: string,
 *     allowAny: boolean,                       // true when allowAgents contains "*"
 *     agents: [{ id, name?, configured }, ...] // requester ALWAYS first;
 *                                              // peers added only when in
 *                                              // subagents.allowAgents (or `*`)
 *   }
 *
 * Population is ALLOWLIST-SCOPED — the model learns the catalog by calling
 * this tool, not from a system-prompt block. With `[main, math]` configured
 * and an empty `subagents.allowAgents`, this returns only the requester.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

import { listAgentEntries } from "../../cli/commands/agents-config.js";
import { loadConfig } from "../../core/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const AgentsListParams = Type.Object({});

interface AgentsListEntry {
	id: string;
	name?: string;
	configured: boolean;
}

interface AgentsListResult {
	requester: string;
	allowAny: boolean;
	agents: AgentsListEntry[];
}

export interface MakeAgentsListToolOptions {
	/** Caller's agent id (so the requester field is accurate). */
	requesterAgentId?: string;
}

export function makeAgentsListTool(
	opts: MakeAgentsListToolOptions = {},
): BrigadeTool<typeof AgentsListParams, AgentsListResult> {
	return {
		name: "agents_list",
		label: "Agents",
		description:
			'List Brigade agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).',
		parameters: AgentsListParams,
		execute: async (_toolCallId: string): Promise<AgentToolResult<AgentsListResult>> => {
			const cfg = loadConfig();
			const requesterAgentId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);

			// Brigade adaptation: cfg.agents is a KEYED MAP. Pull non-defaults
			// entries via listAgentEntries (the same helper `agents list` uses).
			const entries = listAgentEntries(cfg);
			const configuredIds = entries.map((e) => normalizeAgentId(e.id));
			const nameMap = new Map<string, string>();
			for (const { id, entry } of entries) {
				const name = typeof entry.name === "string" ? entry.name.trim() : "";
				if (name) nameMap.set(normalizeAgentId(id), name);
			}

			// Spawn-allowlist resolution (subagents.allowAgents). Per-agent
			// entry → defaults → empty. `*` is the wildcard.
			const spawnAllow = resolveSpawnAllowAgents(cfg, requesterAgentId);
			const allowAny = spawnAllow.some((v) => v.trim() === "*");
			const spawnAllowSet = new Set(
				spawnAllow
					.filter((v) => v.trim() && v.trim() !== "*")
					.map((v) => normalizeAgentId(v)),
			);

			// Requester ALWAYS first; peers added only when they are in the
			// spawn allowlist (or `*`). With an empty allowlist this returns
			// just the requester — exactly OC's contract.
			const isRequesterConfigured =
				configuredIds.includes(requesterAgentId) || requesterAgentId === DEFAULT_AGENT_ID;
			const requesterEntry: AgentsListEntry = {
				id: requesterAgentId,
				configured: isRequesterConfigured,
			};
			const requesterName = nameMap.get(requesterAgentId);
			if (requesterName) requesterEntry.name = requesterName;

			const peers: AgentsListEntry[] = [];
			if (allowAny || spawnAllowSet.size > 0) {
				const sortedConfigured = [...configuredIds]
					.filter((id) => id !== requesterAgentId)
					.sort((a, b) => a.localeCompare(b));
				for (const id of sortedConfigured) {
					if (!(allowAny || spawnAllowSet.has(id))) continue;
					const entry: AgentsListEntry = { id, configured: true };
					const name = nameMap.get(id);
					if (name) entry.name = name;
					peers.push(entry);
				}
				// Allowlist entries that are NOT in cfg.agents — include with
				// configured:false so the model can see what the operator
				// listed even when the underlying agent isn't materialised yet.
				if (!allowAny) {
					for (const id of spawnAllowSet) {
						if (id === requesterAgentId) continue;
						if (configuredIds.includes(id)) continue;
						const entry: AgentsListEntry = { id, configured: false };
						const name = nameMap.get(id);
						if (name) entry.name = name;
						peers.push(entry);
					}
				}
			}

			return jsonResult({
				requester: requesterAgentId,
				allowAny,
				agents: [requesterEntry, ...peers],
			}) as AgentToolResult<AgentsListResult>;
		},
	};
}

/**
 * Resolve `subagents.allowAgents` with per-agent override → defaults fallback.
 * Returns `[]` (no peers) when neither is configured.
 */
function resolveSpawnAllowAgents(cfg: unknown, agentId: string): string[] {
	const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
	if (!agents || typeof agents !== "object") return [];
	const entry = agents[agentId] as { subagents?: { allowAgents?: string[] } } | undefined;
	const perAgent = entry?.subagents?.allowAgents;
	if (Array.isArray(perAgent)) return perAgent.filter((v): v is string => typeof v === "string");
	const defaults = agents.defaults as { subagents?: { allowAgents?: string[] } } | undefined;
	const fallback = defaults?.subagents?.allowAgents;
	if (Array.isArray(fallback)) return fallback.filter((v): v is string => typeof v === "string");
	return [];
}
