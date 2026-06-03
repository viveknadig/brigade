/**
 * Pure config-mutation helper behind the `skills.update` RPC.
 *
 * Given the current config + a partial update (enabled flag, apiKey, env
 * overrides) for one skill, return the next config with
 * `skills.entries[<name>]` patched. The gateway handler wraps this with the
 * load → mutate → save cycle; keeping the mutation pure means the test
 * suite can assert "passing enabled=false flips the entry" without booting
 * a server.
 */

import type { BrigadeConfig, BrigadeSkillEntry } from "../../config/io.js";

export interface SkillUpdateRequest {
	/** Skill name to patch (e.g. `gh`). Required. */
	name: string;
	/** Toggle the skill on/off. Unset means "leave existing value alone". */
	enabled?: boolean;
	/** Replace the skill's api key. Empty/whitespace → delete the field. */
	apiKey?: string;
	/** Per-key env override patch. Empty/whitespace values delete keys. */
	env?: Record<string, string>;
}

export interface SkillUpdateResult {
	config: BrigadeConfig;
	entry: BrigadeSkillEntry;
}

/**
 * Apply a single `skills.update` patch and return the next config + the
 * resulting entry. Does not touch disk — the caller is responsible for
 * persistence.
 */
export function applySkillUpdate(
	current: BrigadeConfig,
	patch: SkillUpdateRequest,
): SkillUpdateResult {
	const name = patch.name.trim();
	if (!name) throw new Error("skills.update: name is required");

	const next: BrigadeConfig = { ...current };
	const skillsBlock = { ...(next.skills ?? {}) };
	const entries = { ...(skillsBlock.entries ?? {}) };
	const existing = entries[name] ?? {};
	const merged: Record<string, unknown> = { ...existing };

	if (typeof patch.enabled === "boolean") merged.enabled = patch.enabled;
	if (typeof patch.apiKey === "string") {
		const trimmed = patch.apiKey.trim();
		if (trimmed.length > 0) merged.apiKey = trimmed;
		else delete merged.apiKey;
	}
	if (patch.env && typeof patch.env === "object") {
		const nextEnv = { ...((merged.env as Record<string, string> | undefined) ?? {}) };
		for (const [k, v] of Object.entries(patch.env)) {
			const tk = k.trim();
			if (!tk) continue;
			const tv = (v ?? "").trim();
			if (!tv) delete nextEnv[tk];
			else nextEnv[tk] = tv;
		}
		merged.env = nextEnv;
	}

	entries[name] = merged as BrigadeSkillEntry;
	skillsBlock.entries = entries;
	next.skills = skillsBlock;
	return { config: next, entry: merged as BrigadeSkillEntry };
}
