/**
 * Skill discovery — the Brigade-native facade over Pi's skill loader.
 *
 * Pi (`loadSkillsFromDir`) does the heavy lifting we want to reuse: SKILL.md
 * discovery (folder-per-skill), frontmatter parse + validation (name matches
 * dir, lowercase, description present), and the standard agentskills.io
 * `<available_skills>` XML render (`formatSkillsForPrompt`). Brigade layers on
 * what Pi structurally lacks: two-root merge (bundled + user workspace),
 * config enable/disable, and OS/binary/env ELIGIBILITY filtering — see
 * `eligibility.ts`.
 *
 * WHY render here instead of letting Pi inject: Brigade pins the whole system
 * prompt via `applyPersonaOverrideToSession`, which replaces Pi's prompt-build
 * hook — so Pi's own skills injection never survives. The agent-loop passes
 * the rendered block into the assembler, so the assembled persona prompt owns
 * the `<available_skills>` section directly. The session's Pi resource loader
 * runs with `noSkills` so nothing is discovered twice.
 *
 * Discovery is a synchronous filesystem scan (Pi's loader is sync). At
 * single-user scale with a handful of skills it's sub-millisecond, so it runs
 * per turn with no cache — a dropped-in skill is live on the very next turn
 * (the "drop-a-folder-it-works" contract) with no watcher to wire.
 */

import * as fs from "node:fs";

import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	type EligibilityEnv,
	isSkillEligible,
	readSkillEligibility,
	type SkillEligibility,
} from "./eligibility.js";

const log = createSubsystemLogger("skills/discovery");

/** Source roots, lowest → highest precedence (later wins on a name collision). */
const SOURCE_BUNDLED = "bundled";
const SOURCE_CONFIG = "config";
const SOURCE_WORKSPACE = "workspace";

/** A discovered, eligible skill — lean metadata for status/diagnostics. */
export interface DiscoveredSkill {
	name: string;
	description: string;
	/** Absolute path to the skill's SKILL.md (or .md) — what the model reads. */
	filePath: string;
	/** Which root it came from ("bundled" | "workspace"). */
	source: string;
	eligibility: SkillEligibility;
}

export interface SkillDiscoveryResult {
	/** Eligible + enabled skills, sorted by name. */
	skills: DiscoveredSkill[];
	/** The rendered `<available_skills>` block, or undefined when none are eligible. */
	promptBlock: string | undefined;
	/** Total skills found on disk BEFORE eligibility/enabled filtering. */
	totalDiscovered: number;
	/** Loader validation diagnostics (bad frontmatter, name mismatch, …). */
	diagnostics: unknown[];
}

export interface DiscoverSkillsArgs {
	/** `<workspace>/skills` — user-authored skills (highest precedence). */
	workspaceSkillsDir: string;
	/** `<packageRoot>/skills` — shipped starter skills. Omit/missing to skip. */
	bundledSkillsDir?: string;
	/** Extra search roots from config (`skills.paths`). Below workspace in precedence. */
	extraPaths?: string[];
	/** Names disabled via config (`skills.entries[name].enabled === false`). */
	disabledNames?: Set<string>;
	/** Injected platform/env for eligibility (tests). Defaults to the live host. */
	eligibilityCtx?: EligibilityEnv;
}

/** Scan one root, tolerating a missing dir. Returns Pi skills + diagnostics. */
function scanRoot(dir: string | undefined, source: string): { skills: Skill[]; diagnostics: unknown[] } {
	if (!dir || !fs.existsSync(dir)) return { skills: [], diagnostics: [] };
	try {
		const res = loadSkillsFromDir({ dir, source });
		return { skills: res.skills, diagnostics: res.diagnostics };
	} catch (err) {
		log.warn("skill root scan failed", {
			dir,
			source,
			error: err instanceof Error ? err.message : String(err),
		});
		return { skills: [], diagnostics: [] };
	}
}

/**
 * Discover skills across the bundled + workspace roots, merge by name
 * (workspace wins), drop config-disabled and ineligible ones, and render the
 * survivors into the `<available_skills>` prompt block.
 */
export function discoverSkills(args: DiscoverSkillsArgs): SkillDiscoveryResult {
	const diagnostics: unknown[] = [];
	// Merge lowest → highest precedence so a workspace skill overrides a
	// same-named bundled (or config-path) one — the user can shadow a shipped
	// skill by dropping a same-named folder in their workspace.
	const roots: Array<[string | undefined, string]> = [[args.bundledSkillsDir, SOURCE_BUNDLED]];
	for (const p of args.extraPaths ?? []) roots.push([p, SOURCE_CONFIG]);
	roots.push([args.workspaceSkillsDir, SOURCE_WORKSPACE]);

	const byName = new Map<string, { skill: Skill; source: string }>();
	for (const [dir, source] of roots) {
		const { skills, diagnostics: diags } = scanRoot(dir, source);
		diagnostics.push(...diags);
		for (const skill of skills) byName.set(skill.name, { skill, source });
	}

	const totalDiscovered = byName.size;
	const disabled = args.disabledNames ?? new Set<string>();
	const ctx = args.eligibilityCtx;

	const eligiblePi: Skill[] = [];
	const skills: DiscoveredSkill[] = [];
	for (const { skill, source } of byName.values()) {
		if (disabled.has(skill.name)) continue;
		const eligibility = readSkillEligibility(skill.filePath);
		if (!(ctx ? isSkillEligible(eligibility, ctx) : isSkillEligible(eligibility))) continue;
		eligiblePi.push(skill);
		skills.push({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			source,
			eligibility,
		});
	}

	skills.sort((a, b) => a.name.localeCompare(b.name));
	eligiblePi.sort((a, b) => a.name.localeCompare(b.name));

	// formatSkillsForPrompt itself drops disableModelInvocation skills, so the
	// rendered block can be empty even when `skills` is not — guard on the
	// rendered text, and treat a whitespace-only render as "nothing".
	const rendered = eligiblePi.length > 0 ? formatSkillsForPrompt(eligiblePi).trim() : "";
	return {
		skills,
		promptBlock: rendered.length > 0 ? rendered : undefined,
		totalDiscovered,
		diagnostics,
	};
}
