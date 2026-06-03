/**
 * Routing-binding helpers for `brigade agents bind / unbind / bindings`.
 * Brand-scrubbed analogue of the reference codebase's
 * `src/commands/agents.bindings.ts`, adapted to Brigade's
 * `cfg.bindings.entries[]` wrapper (vs. the reference's flat `cfg.bindings`).
 *
 * v1 lift: `parseBindingSpecs` validates channel ids against a caller-
 * supplied catalog (Brigade's channel-plugin manager passes
 * `BUNDLED_MODULES → registry.channels` in). The reference codebase's
 * per-plugin `resolveBindingAccountId` hook does not exist on Brigade's
 * adapters yet — when an account id is not supplied explicitly the binding
 * is recorded without one (treated as any-account by the route resolver).
 */

import type { BindingEntry, BrigadeConfig } from "../../config/io.js";
import { listBindings } from "../../agents/routing/bindings.js";
import { normalizeAgentId } from "../../agents/routing/session-key.js";

/**
 * Brigade's already-existing `BindingEntry` carries the same `match` shape
 * the reference codebase calls `AgentRouteBinding`. Re-exported under the
 * alias the spec asks for so downstream call sites can pick whichever name
 * reads best.
 */
export type AgentRouteBinding = BindingEntry;

/* ───────────────────────── match-key helpers (private) ───────────────────── */

const DEFAULT_ACCOUNT_ID = "default";

function trimOrEmpty(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function bindingMatchIdentityKey(match: BindingEntry["match"] | undefined): string {
	const roles = Array.isArray(match?.roles)
		? Array.from(new Set(match.roles.filter((r): r is string => typeof r === "string").sort()))
		: [];
	return JSON.stringify([
		match?.channel ?? "",
		match?.peer?.kind ?? "",
		match?.peer?.id ?? "",
		match?.guildId ?? "",
		match?.teamId ?? "",
		roles.join(","),
	]);
}

function bindingMatchKey(match: BindingEntry["match"] | undefined): string {
	const accountId = trimOrEmpty(match?.accountId) || DEFAULT_ACCOUNT_ID;
	return JSON.stringify([bindingMatchIdentityKey(match), accountId]);
}

function canUpgradeBindingAccountScope(params: {
	existing: BindingEntry;
	incoming: BindingEntry;
	normalizedIncomingAgentId: string;
}): boolean {
	if (!trimOrEmpty(params.incoming.match?.accountId)) return false;
	if (trimOrEmpty(params.existing.match?.accountId)) return false;
	if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) return false;
	return (
		bindingMatchIdentityKey(params.existing.match) ===
		bindingMatchIdentityKey(params.incoming.match)
	);
}

/* ───────────────────────── public helpers ───────────────────────── */

/** Read all configured route bindings (`cfg.bindings.entries[]`). */
export function listRouteBindings(cfg: BrigadeConfig | undefined | null): AgentRouteBinding[] {
	return listBindings(cfg);
}

/** Human-readable single-line description of one binding. */
export function describeBinding(binding: AgentRouteBinding): string {
	const match = binding.match ?? {};
	const parts: string[] = [];
	parts.push(match.channel ?? "(no-channel)");
	if (match.accountId) parts.push(`accountId=${match.accountId}`);
	if (match.peer) parts.push(`peer=${match.peer.kind ?? ""}:${match.peer.id ?? ""}`);
	if (match.guildId) parts.push(`guild=${match.guildId}`);
	if (match.teamId) parts.push(`team=${match.teamId}`);
	if (Array.isArray(match.roles) && match.roles.length > 0) {
		parts.push(`roles=${match.roles.join(",")}`);
	}
	return parts.join(" ");
}

/** Minimal channel-catalog entry consumed by parseBindingSpecs. */
export interface BindingChannelDescriptor {
	id: string;
}

/**
 * Parse CLI binding specs (e.g. `"whatsapp"` or `"whatsapp:account-1"`)
 * into BindingEntry records. Channel ids are validated against the supplied
 * catalog — pass `undefined` to skip validation (useful for tests).
 */
export function parseBindingSpecs(params: {
	agentId: string;
	specs?: string[];
	config: BrigadeConfig;
	channels?: BindingChannelDescriptor[];
}): { bindings: AgentRouteBinding[]; errors: string[] } {
	const bindings: AgentRouteBinding[] = [];
	const errors: string[] = [];
	const specs = params.specs ?? [];
	const agentId = normalizeAgentId(params.agentId);
	const knownIds = params.channels?.map((c) => c.id.trim().toLowerCase()) ?? null;

	for (const raw of specs) {
		const trimmed = raw?.trim();
		if (!trimmed) continue;
		const [channelRaw, ...rest] = trimmed.split(":");
		const accountRaw = rest.length > 0 ? rest.join(":") : undefined;
		const channel = channelRaw?.trim().toLowerCase() ?? "";
		if (!channel) {
			errors.push(`Invalid binding "${trimmed}" (empty channel).`);
			continue;
		}
		if (knownIds && !knownIds.includes(channel)) {
			errors.push(`Unknown channel "${channelRaw}".`);
			continue;
		}
		let accountId: string | undefined;
		if (accountRaw !== undefined) {
			const tr = accountRaw.trim();
			if (!tr) {
				errors.push(`Invalid binding "${trimmed}" (empty account id).`);
				continue;
			}
			accountId = tr;
		}
		const match: BindingEntry["match"] = { channel };
		if (accountId) match.accountId = accountId;
		bindings.push({ agentId, match });
	}
	return { bindings, errors };
}

/**
 * Upsert bindings into `cfg.bindings.entries[]`. Returns a NEW config plus
 * categorised buckets so callers can render the result clearly.
 *
 *  - `skipped`   : key already present, same agent — no-op.
 *  - `conflicts` : key already present, different agent — caller decides
 *                  whether to error or override.
 *  - `updated`   : same agent + same identity-key but the existing record
 *                  had no accountId and the incoming does — in-place upgrade.
 *  - `added`     : net-new binding.
 */
export function applyAgentBindings(
	cfg: BrigadeConfig,
	bindings: AgentRouteBinding[],
): {
	config: BrigadeConfig;
	added: AgentRouteBinding[];
	updated: AgentRouteBinding[];
	skipped: AgentRouteBinding[];
	conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
	const existing = [...listRouteBindings(cfg)];
	const matchMap = new Map<string, string>();
	for (const b of existing) {
		const key = bindingMatchKey(b.match);
		if (!matchMap.has(key)) matchMap.set(key, normalizeAgentId(b.agentId));
	}

	const added: AgentRouteBinding[] = [];
	const updated: AgentRouteBinding[] = [];
	const skipped: AgentRouteBinding[] = [];
	const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

	for (const binding of bindings) {
		const agentId = normalizeAgentId(binding.agentId);
		const key = bindingMatchKey(binding.match);
		const existingAgentId = matchMap.get(key);
		if (existingAgentId) {
			if (existingAgentId === agentId) {
				skipped.push(binding);
			} else {
				conflicts.push({ binding, existingAgentId });
			}
			continue;
		}

		const upgradeIndex = existing.findIndex((candidate) =>
			canUpgradeBindingAccountScope({
				existing: candidate,
				incoming: binding,
				normalizedIncomingAgentId: agentId,
			}),
		);
		if (upgradeIndex >= 0) {
			const current = existing[upgradeIndex];
			if (!current) continue;
			const previousKey = bindingMatchKey(current.match);
			const upgraded: AgentRouteBinding = {
				...current,
				agentId,
				match: {
					...(current.match ?? {}),
					accountId: binding.match?.accountId?.trim(),
				},
			};
			existing[upgradeIndex] = upgraded;
			matchMap.delete(previousKey);
			matchMap.set(bindingMatchKey(upgraded.match), agentId);
			updated.push(upgraded);
			continue;
		}

		matchMap.set(key, agentId);
		const newBinding: AgentRouteBinding = { ...binding, agentId };
		added.push(newBinding);
	}

	if (added.length === 0 && updated.length === 0) {
		return { config: cfg, added, updated, skipped, conflicts };
	}

	const nextEntries = [...existing.filter((e) => !updated.includes(e)), ...updated, ...added];

	return {
		config: {
			...cfg,
			bindings: { entries: nextEntries },
		},
		added,
		updated,
		skipped,
		conflicts,
	};
}

/**
 * Remove bindings from `cfg.bindings.entries[]`. Mirrors `applyAgentBindings`
 * with inverse buckets: `removed` (key matched + agent matched), `missing`
 * (no record with that key at all), `conflicts` (key matched but a different
 * agent owns it — caller decides whether to error).
 */
export function removeAgentBindings(
	cfg: BrigadeConfig,
	bindings: AgentRouteBinding[],
): {
	config: BrigadeConfig;
	removed: AgentRouteBinding[];
	missing: AgentRouteBinding[];
	conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
	const existing = listRouteBindings(cfg);
	const removeIndexes = new Set<number>();
	const removed: AgentRouteBinding[] = [];
	const missing: AgentRouteBinding[] = [];
	const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

	for (const binding of bindings) {
		const desired = normalizeAgentId(binding.agentId);
		const key = bindingMatchKey(binding.match);
		let matchedIndex = -1;
		let conflicting: string | null = null;
		for (let i = 0; i < existing.length; i += 1) {
			if (removeIndexes.has(i)) continue;
			const current = existing[i];
			if (!current) continue;
			if (bindingMatchKey(current.match) !== key) continue;
			const currentAgentId = normalizeAgentId(current.agentId);
			if (currentAgentId === desired) {
				matchedIndex = i;
				break;
			}
			conflicting = currentAgentId;
		}
		if (matchedIndex >= 0) {
			const matched = existing[matchedIndex];
			if (matched) {
				removeIndexes.add(matchedIndex);
				removed.push(matched);
			}
			continue;
		}
		if (conflicting) {
			conflicts.push({ binding, existingAgentId: conflicting });
			continue;
		}
		missing.push(binding);
	}

	if (removeIndexes.size === 0) {
		return { config: cfg, removed, missing, conflicts };
	}

	const nextEntries = existing.filter((_, i) => !removeIndexes.has(i));
	return {
		config: {
			...cfg,
			bindings: { entries: nextEntries },
		},
		removed,
		missing,
		conflicts,
	};
}
