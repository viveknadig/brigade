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
 * Multi-process cache discipline (matters for long-lived gateway + concurrent
 * `brigade exec allow` from another shell):
 *   - The file's mtime is captured at load time. Every `decideApproval` /
 *     `recordApproval` stats the file FIRST; if mtime moved, the cache is
 *     dropped and reloaded. This makes the second-shell flow ("operator runs
 *     `brigade exec allow X` while the TUI is mid-turn") work without
 *     restart — the next bash refusal in the running TUI picks up the new
 *     approval on its next call.
 *   - Cost: one stat() per gate call. Negligible (microseconds) vs the
 *     correctness gain.
 *
 * Concurrent-writer race avoidance (two `brigade exec allow` shells racing):
 *   - Every write reads FRESH from disk first (bypassing cache), merges the
 *     in-memory mutation with whatever's on disk RIGHT NOW, then writes the
 *     union atomically via PID-tagged tempfile + rename. Last writer wins
 *     PER COMMAND, but no entries are LOST. Without this, two shells racing
 *     `brigade exec allow X` then `brigade exec allow Y` could drop one
 *     entry — the second writer would observe its own stale snapshot from
 *     before the first writer's write.
 *
 * File-permission discipline:
 *   - On write we chmod 0600 (operator-only read/write). Allowlist entries
 *     can reveal a lot about an operator's workflow (cloud creds, secrets
 *     paths, internal hostnames) — group/world access is never warranted.
 *   - The check is best-effort on Windows (chmod is a partial-fidelity op
 *     under NTFS) but defensible on POSIX hosts where the threat is real.
 *
 * Symlink-target guard:
 *   - Before writing, lstat the destination — if it's a symbolic link, refuse.
 *     This catches the footgun where an operator (or a malicious dotfile in
 *     a shared system) plants `exec-approvals.json` as a symlink pointing at
 *     `/etc/passwd`; without the guard we'd silently clobber the link entry
 *     on first save, breaking the link harmlessly but obscuring the misuse.
 *     With the guard, the writer throws a typed error so the operator sees
 *     the misuse instead of having it papered over.
 *
 * Brigade-shape choices:
 *   - Brigade is CLI-only in v1, so the gate is in-process and
 *     synchronous. The async multi-channel approval surface (Slack /
 *     Discord / web / CLI all-or-any with timeouts + queue) lands in v3
 *     when channels do.
 *   - Brigade stores a flat `{ commands: string[], patterns: string[] }`
 *     instead of scoping approvals per-channel + per-account.
 *
 * Storage layout (`~/.brigade/exec-approvals.json`):
 *   {
 *     "version": 1,
 *     "commands": ["ls -la", "git status", "npm test"],
 *     "patterns": ["^git diff( |$)", "^cat package\\.json$"]
 *   }
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { BRIGADE_DIR } from "./config.js";

const APPROVALS_FILE = path.join(BRIGADE_DIR, "exec-approvals.json");
const SUPPORTED_SCHEMA_VERSION = 1 as const;

export type ApprovalDecision = "allow" | "deny" | "prompt";

interface ApprovalsFile {
	version: typeof SUPPORTED_SCHEMA_VERSION;
	commands: string[];
	patterns: string[];
}

/**
 * Hard-deny patterns. Match-first, never prompt the operator. Kept short and
 * conservative — the goal is to catch obvious foot-guns, not be a sandbox.
 * The operator has explicitly run `brigade chat` and accepted the v1 trust
 * model; this list exists to prevent autonomous loops from typing fatal
 * commands the operator never would.
 *
 * Coverage spans BOTH POSIX (rm -rf /, dd, fork bombs) and Windows
 * (PowerShell Remove-Item, cmd /c rd / del, Format-Volume, Clear-Disk).
 * Brigade ships on win32 first-class — refusing only POSIX would leave
 * the Windows operator with a half-armored gate.
 */
const HARD_DENY_PATTERNS: RegExp[] = [
	// ── POSIX ─────────────────────────────────────────────────────────
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*[fF]?[a-zA-Z]*|--recursive\s+--force|-rf|-fr)\s+["']?\/["']?(?:\s|$)/, // rm -rf /
	/\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme|hd[a-z])/, // dd to raw disk
	/\bmkfs\.[a-z0-9]+\s+\/dev\//, // format raw disk
	/:\(\)\s*\{[^}]*:\|:[^}]*\}\s*;?\s*:/, // fork bomb
	/\bchmod\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+0+\s+\//, // chmod 000 /
	/\bchown\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+\S+\s+\//, // chown /
	/>\s*\/dev\/sd[a-z]/, // redirect into raw disk
	// ── Windows: cmd.exe ──────────────────────────────────────────────
	// `rd /s [/q] C:\` (variants with /s anywhere in the flag run; optional
	// quotes around the path; ANY path content allowed after the drive
	// letter, including subdirs). REQUIRES /s — `rd C:\Users\me\old` is a
	// legitimate single-directory delete that the operator should be able
	// to allowlist. Once the destructive flag is present AND a drive
	// letter appears later on the same line, the gate refuses regardless
	// of what's after — that's the right defensive default.
	/\brd\s+[^\n]*\/s\b[^\n]*\b[a-z]:/i,
	// `del /f /s /q C:\*` — REQUIRES /s so that single-file deletes like
	// `del /q C:\Users\me\file.txt` aren't false-positively hard-denied.
	// Audit caught this regression in round 3: previously matched any /-flag.
	/\bdel\s+[^\n]*\/s\b[^\n]*\b[a-z]:/i,
	// ── Windows: PowerShell ──────────────────────────────────────────
	// `Remove-Item -Recurse -Force C:\` — flags in any order, optional quotes
	// around the path. Also catches the `ri` alias (Remove-Item shorthand)
	// which a model emitting compact PowerShell might pick. Permissive on
	// path content (matches subdirs, quoted paths, UNC variations).
	/(?:Remove-Item|\bri)\b[^\n]*(?:-Recurse\b[^\n]*-Force|-Force\b[^\n]*-Recurse|-r\b[^\n]*-Force|-Force\b[^\n]*-r)\b[^\n]*\b[a-z]:/i,
	// `Format-Volume -DriveLetter <X>` — silently formats a drive
	/Format-Volume\b[^\n]*-DriveLetter\s+[A-Z]/i,
	// `Clear-Disk -Number N -RemoveData` — wipes a physical disk
	/Clear-Disk\b[^\n]*-RemoveData/i,
];

interface CacheEntry {
	contents: ApprovalsFile;
	/** mtime ms at load time. -1 sentinel = file was missing when loaded. */
	mtimeMs: number;
}

let cache: CacheEntry | null = null;

/**
 * Stat the approvals file and return its mtime, or -1 if it doesn't exist.
 * Defensive against transient stat errors (EACCES on a tempfile rename, etc.) —
 * those propagate the cached snapshot rather than panicking the gate.
 */
function currentMtimeMs(): number {
	try {
		return fs.statSync(APPROVALS_FILE).mtimeMs;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return -1;
		// Other errors (perms, IO) — propagate the existing cache. Operator
		// can run `brigade doctor` to surface the issue.
		return cache?.mtimeMs ?? -1;
	}
}

/**
 * Read + parse the approvals file. On future schema versions we throw a
 * typed error so the gate REFUSES to operate instead of silently dropping
 * fields on the next save. On missing/malformed/empty content we return an
 * empty v1 allowlist — the secure default ("bash is refused until the
 * operator explicitly allows commands"). The mtimeMs arg isn't used here
 * (loadApprovals pins it after the read); it's documentation only.
 */
function loadApprovalsFromDisk(): ApprovalsFile {
	let raw: string;
	try {
		raw = fs.readFileSync(APPROVALS_FILE, "utf8");
	} catch {
		return emptyApprovals();
	}
	if (raw.trim().length === 0) return emptyApprovals();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Malformed JSON → empty allowlist. Operator can repair the file
		// manually or wipe with `brigade exec list --json` then delete.
		return emptyApprovals();
	}
	// Reject obvious shape violations — non-object, array, null.
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return emptyApprovals();
	}
	const obj = parsed as { version?: unknown; commands?: unknown; patterns?: unknown };
	// Schema version gate — refuse anything that isn't v1 outright. A future
	// v2 file MUST be migrated explicitly; silently re-emitting it as v1
	// would lose v2 fields and surprise the next Brigade version.
	if (obj.version !== undefined && obj.version !== SUPPORTED_SCHEMA_VERSION) {
		throw new BrigadeApprovalFileVersionError(
			`exec-approvals.json declares schema version ${JSON.stringify(obj.version)} ` +
				`but this Brigade build only understands v${SUPPORTED_SCHEMA_VERSION}. ` +
				`Either upgrade Brigade, or move the file aside and start fresh: ` +
				`\`mv "${APPROVALS_FILE}" "${APPROVALS_FILE}.from-v${String(obj.version)}.bak"\` ` +
				`then re-approve commands with \`brigade exec allow ...\`.`,
		);
	}
	return {
		version: SUPPORTED_SCHEMA_VERSION,
		commands: Array.isArray(obj.commands) ? obj.commands.filter((s) => typeof s === "string") : [],
		patterns: Array.isArray(obj.patterns) ? obj.patterns.filter((s) => typeof s === "string") : [],
	};
}

function emptyApprovals(): ApprovalsFile {
	return { version: SUPPORTED_SCHEMA_VERSION, commands: [], patterns: [] };
}

/**
 * Load the cache if absent OR if the on-disk file's mtime moved since we
 * captured it. This is the seam that makes the second-shell flow correct:
 * `brigade exec allow X` writes the file from another process; the next
 * `decideApproval` in the gateway/TUI stats the file, sees a new mtime,
 * and reloads.
 */
function loadApprovals(): ApprovalsFile {
	const observed = currentMtimeMs();
	if (cache && cache.mtimeMs === observed) {
		return cache.contents;
	}
	const contents = loadApprovalsFromDisk();
	cache = { contents, mtimeMs: observed };
	return contents;
}

/**
 * Refuse to write through a symbolic link at the destination. A malicious
 * dotfile + a shared host (or simply an operator who symlinked things around)
 * could leave `exec-approvals.json` pointing at `/etc/passwd`; our temp+rename
 * would otherwise replace the symlink entry with a JSON file, harmlessly,
 * but the operator would never know the misuse happened. Throw instead so
 * the misuse is visible. The check uses `lstat` (does NOT follow links) so
 * a missing file returns ENOENT, which we treat as "ok to write".
 *
 * We only check the final file — not every ancestor directory — because
 * legitimate setups symlink `~/.brigade` to e.g. `~/.config/brigade`
 * (XDG-friendly layouts), and walking ancestors would break those.
 */
function refuseAliasedApprovalsPath(): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(APPROVALS_FILE);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // file is fine to create
		// Any other error (EACCES, etc.) — let the upstream write throw a
		// more specific error rather than masking it.
		return;
	}
	if (stat.isSymbolicLink()) {
		throw new BrigadeApprovalRefusedError(
			`refused to write through symlink: "${APPROVALS_FILE}" is a symbolic link. ` +
				`Move or delete the symlink and let Brigade create a regular file: ` +
				`\`rm "${APPROVALS_FILE}"\` then re-run your \`brigade exec\` command.`,
		);
	}
}

/**
 * Atomically write the given contents to the approvals file. PID + random
 * tempfile name so two concurrent writers don't collide on the temp path
 * (one would observe EEXIST and lose the rename race even though their
 * data is fine to write); `flag: "wx"` enforces exclusive create so a
 * collision is reported as an error rather than silently overwriting a
 * stranger's tempfile.
 *
 * Caller is responsible for having read fresh from disk and merged in
 * its mutation BEFORE calling this. This writer does not merge.
 */
function writeApprovalsFileAtomic(contents: ApprovalsFile): void {
	refuseAliasedApprovalsPath();
	fs.mkdirSync(path.dirname(APPROVALS_FILE), { recursive: true });
	const tmp = `${APPROVALS_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(contents, null, 2), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx", // exclusive create — see comment above
		});
		fs.renameSync(tmp, APPROVALS_FILE);
	} catch (err) {
		// Best-effort cleanup of the tempfile if write succeeded but rename
		// failed (e.g. cross-filesystem move on a misconfigured host).
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
	// On POSIX, rename preserves the source's permission bits (which we set
	// to 0600 above). Re-assert anyway to handle the case where the destination
	// existed previously with looser perms — some filesystem semantics inherit
	// from the dest in unexpected ways.
	try {
		fs.chmodSync(APPROVALS_FILE, 0o600);
	} catch {
		// Windows or filesystem without chmod fidelity — ignore.
	}
}

/**
 * Pin the cache to the just-written file's mtime so the NEXT call doesn't
 * spuriously reload. Called after writeApprovalsFileAtomic by every mutator.
 */
function pinCacheAfterWrite(contents: ApprovalsFile): void {
	try {
		const mtimeMs = fs.statSync(APPROVALS_FILE).mtimeMs;
		cache = { contents, mtimeMs };
	} catch {
		// stat failed right after rename — leave cache stale-but-consistent;
		// next read will reload from disk, which is correct behaviour.
		cache = { contents, mtimeMs: -1 };
	}
}

/**
 * Normalize a command for EXACT-match comparison. Collapses internal runs
 * of ASCII whitespace to a single space so a model emitting `"  ls   -la  "`
 * still matches an approved `"ls -la"`. Does NOT lowercase (case matters on
 * POSIX) and does NOT touch quoting/escaping (that's a deeper analysis).
 *
 * Used only for the exact-command allowlist comparison. Hard-deny still
 * runs against the raw (untrimmed) command so embedded-newline injections
 * like `"echo safe\nrm -rf /"` trip the regex correctly.
 */
function normalizeForExactMatch(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

/**
 * Decide whether a command can run without prompting the operator.
 *
 *   - `"deny"` — hard-blocked pattern; caller MUST refuse and never prompt.
 *   - `"allow"` — allowlist hit; caller can run immediately.
 *   - `"prompt"` — caller should surface a TUI prompt; on operator approval,
 *     caller passes the decision back via `recordApproval`.
 *
 * If the file has an unsupported schema version, the load throws — callers
 * (the gate) should refuse the tool call with the typed error's message
 * rather than papering over it.
 */
export function decideApproval(command: string): ApprovalDecision {
	const cmd = command.trim();
	if (!cmd) return "prompt";

	// Hard-deny first. We check before the allowlist so an operator who once
	// approved `rm -rf /home/me/oldproject` can't accidentally have it widen
	// to `rm -rf /` via a pattern match later. Hard-deny uses the trimmed
	// (but otherwise raw) command so embedded-whitespace attacks still match.
	if (isHardDenied(cmd)) return "deny";

	const approvals = loadApprovals();

	// Exact-command allowlist with whitespace-normalised comparison so
	// `"  ls   -la  "` (model emits ragged whitespace) still matches an
	// approved `"ls -la"`. We normalise BOTH sides to avoid storing
	// arbitrarily-shaped strings; the on-disk form is whatever the operator
	// typed verbatim.
	const normalisedCmd = normalizeForExactMatch(cmd);
	for (const entry of approvals.commands) {
		if (normalizeForExactMatch(entry) === normalisedCmd) return "allow";
	}

	// Pattern allowlist. Patterns are operator-supplied regexes — we don't
	// validate here (the operator typed them deliberately). Catch errors so
	// a malformed pattern doesn't crash the gate.
	for (const pat of approvals.patterns) {
		try {
			const re = new RegExp(pat);
			if (re.test(cmd)) return "allow";
		} catch {
			// Skip malformed pattern; operator can clean it up via
			// `brigade exec remove` (or by editing the file directly).
		}
	}

	return "prompt";
}

/**
 * Test-time helper exported so other modules can ask "is this command in
 * the hard-deny set?" without having to re-implement the regex list.
 * Specifically used by the CLI's `brigade exec allow` to refuse writes
 * up-front (BEFORE calling `recordApproval`), and by `recordApproval`
 * itself to enforce the same invariant at the data layer.
 */
export function isHardDenied(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	for (const re of HARD_DENY_PATTERNS) {
		if (re.test(cmd)) return true;
	}
	return false;
}

/**
 * Probe corpus for `patternMatchesHardDeny`. Each entry is a concrete
 * canonical example of a hard-denied command — if an operator's pattern
 * matches ANY of these, the pattern is footgun-shaped and we refuse to
 * persist it. The gate would still catch the actual call via hard-deny,
 * but the pattern's presence misleads operators into thinking they've
 * approved something they haven't.
 */
const HARD_DENY_PROBES: readonly string[] = [
	"rm -rf /",
	"rm -fr /",
	"dd if=/dev/zero of=/dev/sda",
	":(){ :|:& };:",
	"mkfs.ext4 /dev/sdb1",
	"chmod -R 0 /",
	"chown -R root /",
	"> /dev/sda",
	"rd /s /q C:\\",
	"del /f /s /q C:\\*",
	"Remove-Item -Recurse -Force C:\\",
	"ri -Recurse -Force C:\\",
	"Format-Volume -DriveLetter C",
	"Clear-Disk -Number 0 -RemoveData",
];

/**
 * Does a given regex pattern match ANY hard-denied probe command? Used by
 * `recordApproval(kind: "pattern")` to refuse footgun-shaped patterns at
 * write time. We can't enumerate every possible match (regexes are
 * undecidable), but a small probe corpus catches the obvious cases
 * (operator types `^Remove-Item` thinking they're approving `Remove-Item
 * single.txt` — but the gate would never allow it anyway because the
 * pattern also matches the hard-denied `Remove-Item -Recurse -Force C:\`).
 */
export function patternMatchesHardDeny(pattern: string): boolean {
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch {
		// Malformed regex — not our problem here (the CLI rejects malformed
		// regexes up-front). Return false so the caller can proceed to the
		// real validation.
		return false;
	}
	for (const probe of HARD_DENY_PROBES) {
		if (re.test(probe)) return true;
	}
	return false;
}

/**
 * Persist an operator's "always allow" approval. `kind: "exact"` adds the
 * command verbatim; `kind: "pattern"` adds it as a regex. Either way the
 * change lands on disk before the function returns.
 *
 * Concurrent-write safety: we re-read FRESH from disk (bypassing cache) and
 * merge our addition INTO that fresh snapshot, so a sibling process's recent
 * write isn't clobbered. Last writer wins per command, but no entries are
 * lost. Same shape applies to `removeApproval`.
 *
 * Hard-deny safety: an exact command that matches a hard-deny pattern is
 * REFUSED at write-time (throws `BrigadeApprovalRefusedError`). The gate
 * would catch it on the next `decideApproval` anyway, but we'd rather not
 * have a hard-denied command sitting in the allowlist file at all.
 * Pattern approvals are NOT pre-checked (a regex is broad by design;
 * narrowing it to "does this regex match any hard-deny pattern" is a
 * deep semantic question we don't try to answer in v1).
 *
 * `recordApproval` is the ONLY supported write path. Direct edits to
 * `~/.brigade/exec-approvals.json` work and are picked up on the next
 * `decideApproval` (mtime cache invalidation), but operators editing
 * manually should still prefer `brigade exec allow`.
 */
export function recordApproval(command: string, kind: "exact" | "pattern" = "exact"): void {
	const value = command.trim();
	if (!value) return;
	if (kind === "exact" && isHardDenied(value)) {
		throw new BrigadeApprovalRefusedError(
			`refused to record approval: "${value}" matches a hard-deny pattern (rm -rf /, ` +
				`dd to raw disk, fork bomb, etc.). Hard-denied commands are permanently ` +
				`refused by the gate and cannot be allowlisted — pick a safer command.`,
		);
	}
	if (kind === "pattern" && patternMatchesHardDeny(value)) {
		throw new BrigadeApprovalRefusedError(
			`refused to record approval: pattern /${value}/ matches at least one hard-deny ` +
				`command (e.g. "rm -rf /" or "Remove-Item -Recurse -Force C:\\"). The gate ` +
				`would refuse those calls anyway — narrow the pattern with an anchor (^) and ` +
				`a more specific prefix so it only matches what you intend to approve.`,
		);
	}
	// Read FRESH from disk to merge with any sibling-process write.
	const fresh = loadApprovalsFromDisk();
	if (kind === "exact") {
		if (!fresh.commands.includes(value)) fresh.commands.push(value);
	} else {
		if (!fresh.patterns.includes(value)) fresh.patterns.push(value);
	}
	writeApprovalsFileAtomic(fresh);
	pinCacheAfterWrite(fresh);
}

/**
 * Remove an exact command OR a pattern from the allowlist. Looks in BOTH
 * lists — if the value matches either, it's dropped. Returns the count of
 * entries actually removed.
 *
 * Same concurrent-write safety as `recordApproval`: re-reads fresh from
 * disk, mutates the fresh snapshot, writes atomically. Routes through the
 * shared writer so file perms stay 0o600 — previously the CLI's `remove`
 * path bypassed the perm tightening and could regress the file to umask
 * defaults.
 */
export function removeApproval(value: string): { removedCommands: number; removedPatterns: number } {
	const v = value.trim();
	if (!v) return { removedCommands: 0, removedPatterns: 0 };
	const fresh = loadApprovalsFromDisk();
	const beforeCmd = fresh.commands.length;
	const beforePat = fresh.patterns.length;
	fresh.commands = fresh.commands.filter((c) => c !== v);
	fresh.patterns = fresh.patterns.filter((p) => p !== v);
	const removedCommands = beforeCmd - fresh.commands.length;
	const removedPatterns = beforePat - fresh.patterns.length;
	if (removedCommands === 0 && removedPatterns === 0) {
		return { removedCommands: 0, removedPatterns: 0 };
	}
	writeApprovalsFileAtomic(fresh);
	pinCacheAfterWrite(fresh);
	return { removedCommands, removedPatterns };
}

/**
 * Thrown by `recordApproval` (or the writer's symlink guard) when the
 * caller asks Brigade to write something it refuses to write: a hard-denied
 * command, a file at a symbolic-link path, etc.
 */
export class BrigadeApprovalRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrigadeApprovalRefusedError";
	}
}

/**
 * Thrown by the loader when the file's schema version isn't supported.
 * The gate refuses the tool call rather than emitting a partial allowlist.
 */
export class BrigadeApprovalFileVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrigadeApprovalFileVersionError";
	}
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

/**
 * Read-only summary of the on-disk allowlist. Surfaced by `brigade status`
 * / `brigade doctor` so the operator can see at a glance how many commands
 * are approved and where the file lives.
 *
 * Always reads via the cache (so a long-lived gateway sees the same view
 * as any in-flight gate call). Returns zeros when the file is missing or
 * unparseable rather than throwing — the calling diagnostic surface
 * decides how to render an empty state. A version mismatch is reported via
 * the `error` field instead of throwing so `brigade doctor` can render a
 * remediation hint without crashing.
 */
export function readApprovalsSummary(): {
	commandCount: number;
	patternCount: number;
	filePath: string;
	fileExists: boolean;
	error?: string;
} {
	const filePath = APPROVALS_FILE;
	const exists = fs.existsSync(filePath);
	if (!exists) {
		return { commandCount: 0, patternCount: 0, filePath, fileExists: false };
	}
	try {
		const approvals = loadApprovals();
		return {
			commandCount: approvals.commands.length,
			patternCount: approvals.patterns.length,
			filePath,
			fileExists: true,
		};
	} catch (err) {
		return {
			commandCount: 0,
			patternCount: 0,
			filePath,
			fileExists: true,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
