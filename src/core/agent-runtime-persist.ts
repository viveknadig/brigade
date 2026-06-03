/**
 * Pure helpers for the persistence shape the `set-thinking`, `set-model`,
 * and hot-reload `seedAgentsFromConfig` paths in `server.ts` emit. The
 * server still owns the live RPC plumbing (it must mutate
 * `perAgentRuntime`, push into the in-flight Pi session, and broadcast a
 * snapshot); these helpers capture only the on-disk side of the work so
 * unit tests can pin the exact `cfg.agents.<id>` shape that each handler
 * writes without having to boot the whole gateway.
 *
 * Every helper takes the prior `cfg` snapshot and returns the next one,
 * matching the read-modify-write contract `mutateConfigAtomic` expects.
 * No I/O, no closure state.
 */

import type { BrigadeConfig } from "../config/io.js";

/**
 * H4 — `set-thinking` persistence shape.
 *
 * Writes `cfg.agents.<id>.thinking = <level>` so a daemon restart honours
 * the operator's selection instead of resetting to the model-derived
 * default. The boot/seed path reads it back via
 * `readPersistedThinkingLevel` from `model-caps.ts`.
 */
export function applySetThinkingMutation(
	cfg: BrigadeConfig,
	agentId: string,
	level: string,
): BrigadeConfig {
	const next: BrigadeConfig = { ...cfg };
	const agentsMap = {
		...((next.agents as Record<string, unknown> | undefined) ?? {}),
	} as Record<string, unknown>;
	const prevEntry =
		agentsMap[agentId] && typeof agentsMap[agentId] === "object"
			? (agentsMap[agentId] as Record<string, unknown>)
			: {};
	agentsMap[agentId] = { ...prevEntry, thinking: level };
	(next as Record<string, unknown>).agents = agentsMap;
	return next;
}

/**
 * H5 — `set-model` per-agent persistence shape with fallback inheritance.
 *
 * When the per-agent entry has no `model.fallbacks` of its own, this
 * inherits the array from `cfg.agents.defaults.model.fallbacks` so a
 * `set-model` doesn't silently drop the resilient-turn fallback chain
 * the operator configured at onboarding time. If the per-agent entry
 * already declares fallbacks, those are preserved verbatim.
 */
export function applySetModelMutationForAgent(
	cfg: BrigadeConfig,
	agentId: string,
	provider: string,
	modelId: string,
): BrigadeConfig {
	const next: BrigadeConfig = { ...cfg };
	const agentsMap = {
		...((next.agents as Record<string, unknown> | undefined) ?? {}),
	} as Record<string, unknown>;
	const prevEntry =
		(agentsMap[agentId] as { model?: { fallbacks?: string[] } } | undefined) ?? {};
	const prevModel = prevEntry.model ?? {};

	let inheritedFallbacks: string[] | undefined;
	if (!Array.isArray(prevModel.fallbacks) || prevModel.fallbacks.length === 0) {
		const defaults = agentsMap.defaults as
			| { model?: { fallbacks?: unknown } }
			| undefined;
		if (Array.isArray(defaults?.model?.fallbacks)) {
			inheritedFallbacks = (defaults?.model?.fallbacks as unknown[]).filter(
				(f): f is string => typeof f === "string" && f.length > 0,
			);
		}
	}

	const nextModel: { primary: string; fallbacks?: string[] } = {
		...prevModel,
		primary: modelId,
	};
	if (inheritedFallbacks && inheritedFallbacks.length > 0) {
		nextModel.fallbacks = inheritedFallbacks;
	} else if (Array.isArray(prevModel.fallbacks) && prevModel.fallbacks.length > 0) {
		nextModel.fallbacks = prevModel.fallbacks;
	}

	agentsMap[agentId] = {
		...(typeof agentsMap[agentId] === "object" && agentsMap[agentId]
			? (agentsMap[agentId] as Record<string, unknown>)
			: {}),
		provider,
		model: nextModel,
	};
	(next as Record<string, unknown>).agents = agentsMap;
	return next;
}

/**
 * H1 — hot-reload "diff" helper used by the brigade.json watcher.
 *
 * Given the previously-seeded agent-id set and the freshly loaded
 * `cfg.agents` map, returns the ids that should be ADDED to
 * `perAgentRuntime` (new named entries that don't already have a
 * runtime) and the ids that should be REMOVED (previously-seeded
 * entries that vanished from the config). The boot agent is always
 * preserved so the snapshot default never disappears.
 *
 * The actual `Map<string, AgentRuntime>` mutation lives in `server.ts`
 * (it needs the resolved `Model` instances + `AuthStorage`); this
 * helper covers the pure "what changed" calculation that's easy to
 * unit-test.
 */
export function computeSeedDiff(
	previouslySeeded: ReadonlySet<string>,
	bootAgentId: string,
	cfgAgents: Record<string, unknown> | undefined,
): { addedCandidates: string[]; removed: string[] } {
	const map = cfgAgents ?? {};
	const seenIds = new Set<string>([bootAgentId]);
	const addedCandidates: string[] = [];
	for (const [id, entry] of Object.entries(map)) {
		if (id === "defaults" || !entry || typeof entry !== "object") continue;
		seenIds.add(id);
		if (previouslySeeded.has(id)) continue;
		addedCandidates.push(id);
	}
	const removed: string[] = [];
	for (const existingId of previouslySeeded) {
		if (existingId === bootAgentId) continue;
		if (seenIds.has(existingId)) continue;
		removed.push(existingId);
	}
	return { addedCandidates, removed };
}
