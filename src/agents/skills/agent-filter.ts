/**
 * Per-agent skill allowlist resolver.
 *
 * Brigade lets the operator pin which skills a specific agent can see, via
 * `cfg.agents.<id>.skills` (per-agent) and `cfg.agents.defaults.skills`
 * (fallback for any agent without its own override). The semantics mirror
 * the reference codebase Brigade is downstream of:
 *
 *   - present + non-empty array  → restrict to listed skill names
 *   - present + empty array `[]` → agent gets NO skills (explicit deny-all)
 *   - absent                     → inherit from `agents.defaults.skills`
 *   - both absent                → no restriction; every discovered/enabled
 *                                  skill is allowed through
 *
 * The resolver returns `undefined` to mean "no restriction" — kept separate
 * from `[]` so a missing field doesn't silently become a deny-all on
 * round-trip through optional-chains.
 */

import type { BrigadeConfig } from "../../config/io.js";

/**
 * Normalise an unknown value into a clean string[] of skill names. Drops
 * non-strings, trims whitespace, and removes empties so a hand-edited
 * `["gh", " ", "", null]` doesn't accidentally widen the allowlist.
 */
function normaliseSkillNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		out.push(trimmed);
	}
	return out;
}

/**
 * Resolve the effective skill allowlist for the given agent id.
 *
 * Returns:
 *   - `string[]`  — allowlist of names; `[]` means deny all
 *   - `undefined` — no restriction (caller should expose every eligible skill)
 *
 * Lookup order:
 *   1. Per-agent override at `cfg.agents.<id>.skills`
 *   2. Shared default at `cfg.agents.defaults.skills`
 *   3. Undefined (no restriction)
 *
 * `Object.hasOwn` on the per-agent entry is critical: a falsy/empty array
 * still "wins" over defaults when the operator wrote it explicitly. Reading
 * via plain access + truthiness would collapse `[]` into "fall through to
 * defaults", which is exactly the opposite of the operator's intent.
 */
export function resolveEffectiveAgentSkillFilter(
	cfg: BrigadeConfig | undefined,
	agentId: string | undefined,
): string[] | undefined {
	if (!cfg) return undefined;
	const agents = cfg.agents as Record<string, unknown> | undefined;
	if (!agents) return undefined;

	const id = (agentId ?? "").trim();
	if (id) {
		const entry = agents[id];
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const obj = entry as Record<string, unknown>;
			if (Object.hasOwn(obj, "skills")) {
				return normaliseSkillNames(obj.skills);
			}
		}
	}

	const defaults = agents.defaults;
	if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
		const obj = defaults as Record<string, unknown>;
		if (Object.hasOwn(obj, "skills")) {
			return normaliseSkillNames(obj.skills);
		}
	}

	return undefined;
}

/**
 * True when the given skill name should be exposed under the supplied
 * allowlist. Undefined allowlist = unrestricted (always true).
 */
export function isSkillAllowedForAgent(
	skillName: string,
	allowlist: string[] | undefined,
): boolean {
	if (allowlist === undefined) return true;
	return allowlist.includes(skillName);
}
