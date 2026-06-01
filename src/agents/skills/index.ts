/**
 * Skills (Primitive #5) — public entry point.
 *
 * `discoverEligibleSkills` is the one call the runtime makes per turn: it reads
 * the skills config, resolves the bundled + workspace + config-extra roots, and
 * returns the eligible skills plus the rendered `<available_skills>` prompt
 * block. The agent-loop passes the block into the assembler (gated on
 * `capabilities.skills`) and the model loads a skill's body on demand with the
 * existing `read` tool — no skill-specific tool exists.
 */

import * as path from "node:path";

import type { BrigadeConfig } from "../../config/io.js";
import { resolveBundledSkillsDir } from "../../config/paths.js";
import { discoverSkills, type DiscoveredSkill, type SkillDiscoveryResult } from "./discovery.js";

export {
	discoverSkills,
	type DiscoveredSkill,
	type SkillDiscoveryResult,
	type DiscoverSkillsArgs,
} from "./discovery.js";
export {
	isSkillEligible,
	hasBinary,
	readSkillEligibility,
	parseEligibility,
	type SkillEligibility,
} from "./eligibility.js";

/** The empty result — skills disabled or none found. */
const EMPTY: SkillDiscoveryResult = {
	skills: [],
	promptBlock: undefined,
	totalDiscovered: 0,
	diagnostics: [],
};

/** Names disabled via `skills.entries[<name>].enabled === false`. */
function resolveDisabledNames(config: BrigadeConfig): Set<string> {
	const out = new Set<string>();
	const entries = config.skills?.entries;
	if (!entries) return out;
	for (const [name, entry] of Object.entries(entries)) {
		if (entry && entry.enabled === false) out.add(name);
	}
	return out;
}

export interface DiscoverEligibleSkillsArgs {
	/** Resolved workspace dir (same value memory/persona use) — skills live in `<workspaceDir>/skills`. */
	workspaceDir: string;
	/** The active config (caller already has it loaded; avoids a second read). */
	config: BrigadeConfig;
}

/**
 * Discover the skills eligible for this turn. Returns the empty result when the
 * subsystem is globally disabled (`skills.enabled === false`). Synchronous +
 * cheap (a small directory scan), so it runs per turn with no caching.
 */
export function discoverEligibleSkills(args: DiscoverEligibleSkillsArgs): SkillDiscoveryResult {
	if (args.config.skills?.enabled === false) return EMPTY;
	return discoverSkills({
		workspaceSkillsDir: path.join(args.workspaceDir, "skills"),
		bundledSkillsDir: resolveBundledSkillsDir(),
		extraPaths: args.config.skills?.paths ?? [],
		disabledNames: resolveDisabledNames(args.config),
		// Pass the active config so `requires.config` paths actually gate
		// channel-specific skills (e.g. a bluebubbles skill is hidden when
		// the operator has no `channels.bluebubbles` section). Without this
		// the eligibility evaluator conservatively allows every skill that
		// passes os/bins/env — exactly the case that surfaced when the model
		// tried to invoke the bluebubbles skill to send a WhatsApp message.
		eligibilityCtx: {
			platform: process.platform,
			env: process.env,
			config: args.config,
		},
	});
}
