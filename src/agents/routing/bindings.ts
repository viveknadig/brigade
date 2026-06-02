/**
 * Bindings accessor — single entry point that reads `cfg.bindings.entries[]`.
 *
 * Brand-scrubbed analogue of the upstream `src/routing/bindings.ts`'s
 * `listBindings(cfg)`. The fuller upstream module also exports
 * `listBoundAccountIds`, `resolveDefaultAgentBoundAccountId`,
 * `buildChannelAccountBindings`, `resolvePreferredAccountId` — those
 * helpers land later as channel-manager fan-out consumers arrive.
 *
 * For now the 8-tier route resolver only needs the raw list, so we
 * ship a single function. The shape consumed:
 *
 *   `BindingEntry = { agentId, match?: { channel?, accountId?, peer?, guildId?, teamId?, roles? } }`
 *
 * Missing / non-array `cfg.bindings.entries` returns `[]` (every tier
 * predicate's `enabled` flag handles the empty case naturally).
 */

import type { BindingEntry, BrigadeConfig } from "../../config/types.js";

export function listBindings(cfg: BrigadeConfig | undefined | null): BindingEntry[] {
	const entries = cfg?.bindings?.entries;
	return Array.isArray(entries) ? entries : [];
}
