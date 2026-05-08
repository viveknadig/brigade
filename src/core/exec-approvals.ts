/**
 * Brigade exec-approvals — synchronous tool-approval gate for `bash` and any
 * future tool that touches the operator's machine.
 *
 * v1 shape (single-user, file-backed allowlist):
 *   - Operator approves once → command (or pattern) lands in an allowlist file
 *     at `~/.brigade/exec-approvals.json`.
 *   - Subsequent invocations of the same command short-circuit `decideApproval`
 *     → returns `"allow"` without prompting.
 *   - Unknown commands return `"prompt"`; the caller (bash tool) then surfaces
 *     a TUI prompt and writes the decision back via `recordApproval`.
 *   - Hard-deny patterns (rm -rf /, dd to /dev/sda, etc.) return `"deny"` and
 *     are NEVER stored. Caller rejects without prompting the operator.
 *
 * Brigade-shape vs OpenClaw:
 *   - OpenClaw routes approvals through a multi-channel async pipeline
 *     (Slack/Discord/web/CLI all-or-any) with timeouts + queue. Brigade is
 *     CLI-only in v1, so the gate is in-process and synchronous. The async
 *     channel surface lands in v3 when channels do.
 *   - OpenClaw stores approvals scoped per-channel + per-account. Brigade
 *     stores a flat `{ commands: string[], patterns: string[] }`.
 *
 * Storage layout (`~/.brigade/exec-approvals.json`):
 *   {
 *     "version": 1,
 *     "commands": ["ls -la", "git status", "npm test"],
 *     "patterns": ["^git diff( |$)", "^cat package\\.json$"]
 *   }
 *
 * The file is read once per process and cached in memory. `recordApproval`
 * mutates both the cache and the file (atomic replace via tempfile + rename).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { BRIGADE_DIR } from "./config.js";

const APPROVALS_FILE = path.join(BRIGADE_DIR, "exec-approvals.json");

export type ApprovalDecision = "allow" | "deny" | "prompt";

interface ApprovalsFile {
	version: 1;
	commands: string[];
	patterns: string[];
}

/**
 * Hard-deny patterns. Match-first, never prompt the operator. Kept short and
 * conservative — the goal is to catch obvious foot-guns, not be a sandbox.
 * The operator has explicitly run `brigade chat` and accepted the v1 trust
 * model; this list exists to prevent autonomous loops from typing fatal
 * commands the operator never would.
 */
const HARD_DENY_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*[fF]?[a-zA-Z]*|--recursive\s+--force|-rf|-fr)\s+\/(?:\s|$)/, // rm -rf /
	/\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme|hd[a-z])/, // dd to raw disk
	/\bmkfs\.[a-z0-9]+\s+\/dev\//, // format raw disk
	/:\(\)\s*\{[^}]*:\|:[^}]*\}\s*;?\s*:/, // fork bomb
	/\bchmod\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+0+\s+\//, // chmod 000 /
	/\bchown\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+\S+\s+\//, // chown /
	/>\s*\/dev\/sd[a-z]/, // redirect into raw disk
];

let cache: ApprovalsFile | null = null;

function loadApprovals(): ApprovalsFile {
	if (cache) return cache;
	try {
		const raw = fs.readFileSync(APPROVALS_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<ApprovalsFile>;
		cache = {
			version: 1,
			commands: Array.isArray(parsed.commands) ? parsed.commands.filter((s) => typeof s === "string") : [],
			patterns: Array.isArray(parsed.patterns) ? parsed.patterns.filter((s) => typeof s === "string") : [],
		};
	} catch {
		// Missing or malformed → start with an empty allowlist. We never
		// auto-create the file on read; first `recordApproval` writes it.
		cache = { version: 1, commands: [], patterns: [] };
	}
	return cache;
}

function saveApprovals(): void {
	if (!cache) return;
	const tmp = `${APPROVALS_FILE}.tmp`;
	fs.mkdirSync(path.dirname(APPROVALS_FILE), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
	fs.renameSync(tmp, APPROVALS_FILE);
}

/**
 * Decide whether a command can run without prompting the operator.
 *
 *   - `"deny"` — hard-blocked pattern; caller MUST refuse and never prompt.
 *   - `"allow"` — allowlist hit; caller can run immediately.
 *   - `"prompt"` — caller should surface a TUI prompt; on operator approval,
 *     caller passes the decision back via `recordApproval`.
 */
export function decideApproval(command: string): ApprovalDecision {
	const cmd = command.trim();
	if (!cmd) return "prompt";

	// Hard-deny first. We check before the allowlist so an operator who once
	// approved `rm -rf /home/me/oldproject` can't accidentally have it widen
	// to `rm -rf /` via a pattern match later.
	for (const re of HARD_DENY_PATTERNS) {
		if (re.test(cmd)) return "deny";
	}

	const approvals = loadApprovals();

	// Exact-command allowlist.
	if (approvals.commands.includes(cmd)) return "allow";

	// Pattern allowlist. Patterns are operator-supplied regexes — we don't
	// validate here (the operator typed them deliberately). Catch errors so
	// a malformed pattern doesn't crash the gate.
	for (const pat of approvals.patterns) {
		try {
			const re = new RegExp(pat);
			if (re.test(cmd)) return "allow";
		} catch {
			// Skip malformed pattern; operator can clean it up via
			// `brigade config` (or by editing the file directly).
		}
	}

	return "prompt";
}

/**
 * Persist an operator's "always allow" approval. `kind: "exact"` adds the
 * command verbatim; `kind: "pattern"` adds it as a regex. Either way the
 * change lands on disk before the function returns.
 *
 * `recordApproval` is the ONLY supported write path. Direct edits to
 * `~/.brigade/exec-approvals.json` work but invalidate the in-memory cache
 * until the next process start — operators editing manually should use
 * `brigade config` or restart the gateway.
 */
export function recordApproval(command: string, kind: "exact" | "pattern" = "exact"): void {
	const approvals = loadApprovals();
	const value = command.trim();
	if (!value) return;
	if (kind === "exact") {
		if (!approvals.commands.includes(value)) approvals.commands.push(value);
	} else {
		if (!approvals.patterns.includes(value)) approvals.patterns.push(value);
	}
	saveApprovals();
}

/**
 * Test-only helper. Wipes the in-memory cache so the next call to
 * `decideApproval` re-reads from disk. Production code should never need this.
 */
export function _resetApprovalsCacheForTests(): void {
	cache = null;
}

/**
 * Return the absolute path to the approvals file. Useful for `brigade doctor`
 * + `brigade status` so the operator knows where the trust list lives.
 */
export function getApprovalsFilePath(): string {
	return APPROVALS_FILE;
}
