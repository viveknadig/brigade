/**
 * Skill status reporter — the diagnostic surface behind the `skills.status`
 * RPC. Built by walking the same discovery roots the per-turn assembler
 * walks, then projecting each candidate skill (eligible OR not) into a
 * stable wire shape so the operator can see WHY a skill was hidden:
 *
 *   - `eligible: false` + `missing.{bins,anyBins,env,config}` populated
 *     → skill failed an os/bins/env/config requirement
 *   - `eligible: false` + `blockedByAllowlist: true`
 *     → per-agent `cfg.agents.<id>.skills` (or `defaults.skills`) hides it
 *   - `eligible: false` + `disabled: true`
 *     → operator turned the skill off via `cfg.skills.entries[<name>].enabled`
 *
 * Brand-scrubbed analogue of the reference codebase's `skills-status.ts` +
 * the `skills.status` gateway method. Brigade omits the install-option
 * picker (no ClawHub-style remote registry yet); the per-skill `install`
 * field is reserved for the SkillInstallSpec block authored in SKILL.md
 * frontmatter and is intentionally undefined for hand-authored skills.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

import type { BrigadeConfig } from "../../config/io.js";
import {
	resolveBundledSkillsDir,
	resolveManagedSkillsDir,
} from "../../config/paths.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import {
	SOURCE_MANAGED,
	SOURCE_PERSONAL,
	SOURCE_PROJECT,
} from "./discovery.js";
import {
	hasBinary,
	isConfigPathTruthy,
	isSkillEligible,
	readSkillEligibility,
	type SkillEligibility,
} from "./eligibility.js";

/** Per-requirement diagnostics — what the skill declared + what is missing. */
export interface SkillStatusRequirements {
	os?: string[];
	bins?: string[];
	anyBins?: string[];
	env?: string[];
	config?: string[];
}

/** One row of the `skills.status` report. */
export interface SkillStatusEntry {
	name: string;
	description: string;
	source: string;
	filePath: string;
	/** True when `cfg.skills.entries[<name>].enabled === false`. */
	disabled: boolean;
	/** True when the per-agent / defaults allowlist excludes this skill. */
	blockedByAllowlist: boolean;
	/** True when os/bins/env/config + allowlist + disabled all pass. */
	eligible: boolean;
	/** Verbatim requirements declared in the skill's SKILL.md frontmatter. */
	requirements: SkillStatusRequirements;
	/** Subset of `requirements` that is NOT satisfied on this host. */
	missing: SkillStatusRequirements;
}

export interface SkillStatusReport {
	workspaceDir: string;
	managedSkillsDir: string;
	skills: SkillStatusEntry[];
}

/** Source roots, lowest → highest precedence. Mirrors discoverSkills(). */
function buildRoots(
	workspaceDir: string,
	config: BrigadeConfig,
): Array<{ dir: string; source: string }> {
	const out: Array<{ dir: string; source: string }> = [];
	const push = (dir: string | undefined, source: string): void => {
		if (dir && dir.length > 0) out.push({ dir, source });
	};
	push(resolveBundledSkillsDir(), "bundled");
	for (const p of config.skills?.paths ?? []) push(p, "config");
	push(resolveManagedSkillsDir(), SOURCE_MANAGED);
	push(path.join(os.homedir(), ".agents", "skills"), SOURCE_PERSONAL);
	push(path.join(workspaceDir, ".agents", "skills"), SOURCE_PROJECT);
	push(path.join(workspaceDir, "skills"), "workspace");
	return out;
}

function scanRoot(dir: string, source: string): Array<{ skill: Skill; source: string }> {
	if (!fs.existsSync(dir)) return [];
	try {
		const res = loadSkillsFromDir({ dir, source });
		return res.skills.map((skill) => ({ skill, source }));
	} catch {
		return [];
	}
}

/**
 * Compute the missing subset of a skill's declared requirements. Mirrors the
 * decision pattern in `isSkillEligible` so the report agrees with the
 * runtime gate.
 */
function computeMissing(
	meta: SkillEligibility,
	platform: string,
	env: NodeJS.ProcessEnv,
	config: unknown,
): SkillStatusRequirements {
	const missing: SkillStatusRequirements = {};
	if (meta.os.length > 0 && !meta.os.includes(platform)) {
		missing.os = [platform];
	}
	const missingBins = meta.requiresBins.filter((bin) => !hasBinary(bin, env));
	if (missingBins.length > 0) missing.bins = missingBins;
	if (
		meta.requiresAnyBins.length > 0 &&
		!meta.requiresAnyBins.some((bin) => hasBinary(bin, env))
	) {
		missing.anyBins = [...meta.requiresAnyBins];
	}
	const missingEnv = meta.requiresEnv.filter((key) => {
		const v = env[key];
		return !v || v.trim().length === 0;
	});
	if (missingEnv.length > 0) missing.env = missingEnv;
	const missingConfig = meta.requiresConfig.filter(
		(dottedPath) => !isConfigPathTruthy(config, dottedPath),
	);
	if (missingConfig.length > 0) missing.config = missingConfig;
	return missing;
}

function toRequirements(meta: SkillEligibility): SkillStatusRequirements {
	const r: SkillStatusRequirements = {};
	if (meta.os.length > 0) r.os = [...meta.os];
	if (meta.requiresBins.length > 0) r.bins = [...meta.requiresBins];
	if (meta.requiresAnyBins.length > 0) r.anyBins = [...meta.requiresAnyBins];
	if (meta.requiresEnv.length > 0) r.env = [...meta.requiresEnv];
	if (meta.requiresConfig.length > 0) r.config = [...meta.requiresConfig];
	return r;
}

export interface BuildSkillStatusReportArgs {
	workspaceDir: string;
	config: BrigadeConfig;
	/** Optional agent id — used to resolve the effective skill allowlist. */
	agentId?: string;
	/** Override host platform (tests). */
	platform?: string;
	/** Override env (tests). */
	env?: NodeJS.ProcessEnv;
}

/**
 * Build a full status report for the supplied workspace + config. Walks every
 * known scan root, dedupes by name (highest precedence wins, matching the
 * runtime discovery order), and projects each candidate to a wire-stable
 * `SkillStatusEntry`. Used by the `skills.status` RPC.
 */
export function buildSkillStatusReport(args: BuildSkillStatusReportArgs): SkillStatusReport {
	const platform = args.platform ?? process.platform;
	const env = args.env ?? process.env;
	const allowlist = resolveEffectiveAgentSkillFilter(args.config, args.agentId);
	const disabledEntries = args.config.skills?.entries ?? {};

	const byName = new Map<string, { skill: Skill; source: string }>();
	for (const root of buildRoots(args.workspaceDir, args.config)) {
		for (const found of scanRoot(root.dir, root.source)) {
			byName.set(found.skill.name, found);
		}
	}

	const skills: SkillStatusEntry[] = [];
	for (const { skill, source } of byName.values()) {
		const eligibility = readSkillEligibility(skill.filePath);
		const requirements = toRequirements(eligibility);
		const missing = computeMissing(eligibility, platform, env, args.config);
		const requirementsOk = isSkillEligible(eligibility, {
			platform,
			env,
			config: args.config,
		});
		const disabledEntry = disabledEntries[skill.name];
		const disabled = disabledEntry?.enabled === false;
		const blockedByAllowlist =
			allowlist !== undefined && !allowlist.includes(skill.name);
		const eligible = requirementsOk && !disabled && !blockedByAllowlist;
		skills.push({
			name: skill.name,
			description: skill.description,
			source,
			filePath: skill.filePath,
			disabled,
			blockedByAllowlist,
			eligible,
			requirements,
			missing,
		});
	}

	skills.sort((a, b) => a.name.localeCompare(b.name));
	return {
		workspaceDir: args.workspaceDir,
		managedSkillsDir: resolveManagedSkillsDir(),
		skills,
	};
}
