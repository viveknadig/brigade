/**
 * IDENTITY.md parser + loader. Lifted from the reference codebase's
 * `src/agents/identity-file.ts` (same name + path on purpose) so consumers
 * find it where the reference's mental model expects.
 *
 * Brigade-specific bits:
 *   - Identity type is `BrigadeAgentIdentity` (Brigade-native naming).
 *   - `identityHasValues` is exported because the agents-list command needs it
 *     to decide whether to surface an identity row at all.
 */

import fs from "node:fs";
import path from "node:path";

/** Identity fields a Brigade agent can carry (mirrors IDENTITY.md bullets). */
export interface BrigadeAgentIdentity {
	name?: string;
	emoji?: string;
	creature?: string;
	vibe?: string;
	theme?: string;
	avatar?: string;
}

/** Placeholder values that should be treated as "no identity provided". */
const IDENTITY_PLACEHOLDERS = new Set([
	"pick something you like",
	"ai? robot? familiar? ghost in the machine? something weirder?",
	"how do you come across? sharp? warm? chaotic? calm?",
	"your signature - pick one that feels right",
	"workspace-relative path, http(s) url, or data uri",
]);

function normIdentityValue(raw: string): string {
	let v = raw.trim();
	v = v.replace(/^[*_]+|[*_]+$/g, "").trim();
	if (v.startsWith("(") && v.endsWith(")")) v = v.slice(1, -1).trim();
	return v.replace(/\s+/g, " ");
}

/** Parse IDENTITY.md markdown content into a BrigadeAgentIdentity. */
export function parseIdentityMarkdown(content: string): BrigadeAgentIdentity {
	const out: BrigadeAgentIdentity = {};
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		const cleaned = line.trim().replace(/^\s*-\s*/, "");
		const colonIndex = cleaned.indexOf(":");
		if (colonIndex === -1) continue;
		const label = cleaned
			.slice(0, colonIndex)
			.replace(/[*_]/g, "")
			.trim()
			.toLowerCase();
		const value = cleaned
			.slice(colonIndex + 1)
			.replace(/^[*_]+|[*_]+$/g, "")
			.trim();
		if (!value) continue;
		if (IDENTITY_PLACEHOLDERS.has(normIdentityValue(value).toLowerCase())) continue;
		if (label === "name") out.name = value;
		else if (label === "emoji") out.emoji = value;
		else if (label === "creature") out.creature = value;
		else if (label === "vibe") out.vibe = value;
		else if (label === "theme") out.theme = value;
		else if (label === "avatar") out.avatar = value;
	}
	return out;
}

/** True iff the identity has at least one non-empty field. */
export function identityHasValues(identity: BrigadeAgentIdentity): boolean {
	return Boolean(
		identity.name ||
			identity.emoji ||
			identity.theme ||
			identity.creature ||
			identity.vibe ||
			identity.avatar,
	);
}

/** Load + parse `<workspace>/IDENTITY.md`. Returns null when absent or empty. */
export function loadAgentIdentity(workspace: string): BrigadeAgentIdentity | null {
	try {
		const file = path.join(workspace, "IDENTITY.md");
		const content = fs.readFileSync(file, "utf8");
		const parsed = parseIdentityMarkdown(content);
		return identityHasValues(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
