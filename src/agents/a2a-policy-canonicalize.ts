/**
 * Shared A2A-policy canonicaliser used by both:
 *
 *   - `applyAutoEnableA2AOnAgentCreate` (CLI `brigade agents add` /
 *     `manage_agent({action:"add"})`)
 *   - `applyAutoEnableA2AAtBoot` (gateway `continueBoot()` right after
 *     `loadConfig()` — see `core/server.ts`)
 *
 * Brigade is personal-crew-first, so A2A messaging via `sessions_send` should
 * work out of the box. The canonical policy is wide-open:
 *
 *   `{ enabled: true, allow: [{ from: "*", to: "*" }] }`
 *
 * Behaviour by current state of `cfg.session.agentToAgent`:
 *   1. Missing or not a plain object  → write the canonical default
 *   2. Literal boolean `true` (broken legacy shape) → coerce to canonical
 *   3. Object with `enabled` missing/false → set `enabled: true`, preserve
 *      `allow` (and any other operator-authored fields) untouched
 *   4. Object with `enabled: true` already → idempotent no-op
 *
 * Gated by a per-call flag name (`autoEnableA2AOnAgentCreate` for the
 * add-time seed, `autoEnableA2AAtBoot` for the boot-time seed). When the
 * named flag is the literal boolean `false`, the canonicaliser is a no-op —
 * the operator's narrow allow list survives unchanged. The two flags are
 * independent toggles; an operator can opt out of the boot seed without
 * turning off the add-time seed and vice versa.
 *
 * The companion `pruneAgentConfig` (in `cli/commands/agents-config.ts`)
 * strips the deleted agent id from any `allow` pair on `agents delete`, so
 * add+delete stay symmetric without a separate code path.
 */

import type { BrigadeConfig } from "../config/io.js";

/** Names of the gate flags that opt an operator OUT of the canonicalisation. */
export type A2AAutoEnableGateFlag =
	| "autoEnableA2AOnAgentCreate"
	| "autoEnableA2AAtBoot";

/**
 * Canonicalise `cfg.session.agentToAgent` against the gate flag named by
 * `opts.gateFlag`. Returns the same `cfg` reference when no change is
 * required (idempotent) so callers can detect a no-op via reference equality.
 */
export function canonicalizeA2APolicy(
	cfg: BrigadeConfig,
	opts: { gateFlag: A2AAutoEnableGateFlag },
): BrigadeConfig {
	const sessionRaw = (cfg.session as Record<string, unknown> | undefined) ?? {};
	// Operator opted out via the named gate flag — leave the policy alone.
	if (sessionRaw[opts.gateFlag] === false) return cfg;

	const a2aRaw = sessionRaw["agentToAgent"];

	const canonical = { enabled: true, allow: [{ from: "*", to: "*" }] };

	// (1) Missing → write the canonical default.
	// (2 broken legacy) The literal boolean `true` → coerce to canonical.
	const isPlainObject =
		a2aRaw !== null && typeof a2aRaw === "object" && !Array.isArray(a2aRaw);
	if (a2aRaw === undefined || a2aRaw === null || !isPlainObject) {
		const nextSession: Record<string, unknown> = { ...sessionRaw, agentToAgent: canonical };
		return { ...cfg, session: nextSession as BrigadeConfig["session"] };
	}

	const a2aObj = a2aRaw as Record<string, unknown>;
	const currentEnabled = a2aObj["enabled"];
	// (4) Already enabled — idempotent no-op.
	if (currentEnabled === true) return cfg;

	// (3) Object with `enabled` missing/false → set enabled:true, preserve allow + other fields.
	const nextA2A: Record<string, unknown> = { ...a2aObj, enabled: true };
	const nextSession: Record<string, unknown> = { ...sessionRaw, agentToAgent: nextA2A };
	return { ...cfg, session: nextSession as BrigadeConfig["session"] };
}

/**
 * Add-time variant — invoked by `brigade agents add` /
 * `manage_agent({action:"add"})` after the new agent has been staged.
 * Gated by `cfg.session.autoEnableA2AOnAgentCreate` (default `true`).
 *
 * The existing call sites import this name; keep the export stable.
 */
export function applyAutoEnableA2AOnAgentCreate(cfg: BrigadeConfig): BrigadeConfig {
	return canonicalizeA2APolicy(cfg, { gateFlag: "autoEnableA2AOnAgentCreate" });
}

/**
 * Boot-time variant — invoked by `continueBoot()` in `core/server.ts`
 * immediately after `loadConfig()` and before channels / cron / heartbeat /
 * sessions-access-guard read `cfg.session.agentToAgent`.
 *
 * Gated by `cfg.session.autoEnableA2AAtBoot` (default `true`). Operators
 * set this flag to `false` for strict-allowlist installs.
 */
export function applyAutoEnableA2AAtBoot(cfg: BrigadeConfig): BrigadeConfig {
	return canonicalizeA2APolicy(cfg, { gateFlag: "autoEnableA2AAtBoot" });
}
