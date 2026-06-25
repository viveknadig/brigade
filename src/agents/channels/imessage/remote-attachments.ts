/**
 * iMessage remote-host attachment fetch.
 *
 * The `imsg` bridge can run on a DIFFERENT Mac than the gateway — operators wrap
 * `cliPath` in an SSH script like `exec ssh -T user@mac-mini imsg "$@"`. In that
 * setup an inbound attachment's `original_path` is a path on the REMOTE machine,
 * so resolving it against the local filesystem fails. This module:
 *
 *   1. `normalizeScpRemoteHost` — safety-validate a `user@host` / `host` token so
 *      it can NEVER inject an option/argument into the `scp` command line.
 *   2. `detectRemoteHostFromCliPath` — parse an SSH-wrapper script at `cliPath`
 *      to auto-detect the remote host (so `remoteHost` need not be set by hand).
 *   3. `scpCopyRemoteAttachment` — copy a remote attachment to a local temp file
 *      (validated against the configured remote roots) before it is resolved.
 *
 * `scp`/`readFile`/`spawn` are all INJECTABLE so the unit tests exercise the
 * remote path with NO real ssh/scp and NO real filesystem. Ported from the
 * upstream iMessage monitor-provider remote-host support + `scp-host.ts`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* ───────────────────────── host safety ───────────────────────── */

const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;

function hasControlOrWhitespace(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f || WHITESPACE.test(char)) return true;
	}
	return false;
}

/**
 * Safety-validate + normalise an SCP/SSH remote host. Returns the canonical
 * `user@host` / `host` string, or `undefined` when the value is unsafe (contains
 * whitespace/control chars, looks like an option `-…`, embeds a path separator,
 * has a malformed `user@host`, etc.). Ported from `normalizeScpRemoteHost`.
 */
export function normalizeScpRemoteHost(value: string | null | undefined): string | undefined {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return undefined;
	if (hasControlOrWhitespace(trimmed)) return undefined;
	if (trimmed.startsWith("-") || trimmed.includes("/") || trimmed.includes("\\")) return undefined;

	const firstAt = trimmed.indexOf("@");
	const lastAt = trimmed.lastIndexOf("@");

	let user: string | undefined;
	let host = trimmed;

	if (firstAt !== -1) {
		if (firstAt !== lastAt || firstAt === 0 || firstAt === trimmed.length - 1) return undefined;
		user = trimmed.slice(0, firstAt);
		host = trimmed.slice(firstAt + 1);
		if (!SSH_TOKEN.test(user)) return undefined;
	}

	if (!host || host.startsWith("-") || host.includes("@")) return undefined;
	if (host.includes(":") && !BRACKETED_IPV6.test(host)) return undefined;
	if (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host)) return undefined;

	return user ? `${user}@${host}` : host;
}

/* ───────────────────────── cliPath detection ───────────────────────── */

/** TEST SEAM: read the wrapper-script file (defaults to fs `readFile`). */
export type ReadFileLike = (filePath: string) => Promise<string>;

const defaultReadFile: ReadFileLike = (filePath) => readFile(filePath, "utf8");

/** Expand a leading `~` to the user's home dir. */
function expandHome(p: string): string {
	if (p.startsWith("~")) return p.replace(/^~/, os.homedir());
	return p;
}

/**
 * Try to detect a remote host from an SSH-wrapper script at `cliPath`, e.g.:
 *   exec ssh -T user@192.168.64.3 /opt/homebrew/bin/imsg "$@"
 *   exec ssh -T mac-mini imsg "$@"
 * Returns the `user@host` / `host` portion (unvalidated — the caller normalises)
 * or undefined when the file is unreadable / has no ssh invocation. Never throws.
 */
export async function detectRemoteHostFromCliPath(
	cliPath: string,
	readFileImpl: ReadFileLike = defaultReadFile,
): Promise<string | undefined> {
	try {
		const content = await readFileImpl(expandHome(cliPath));
		// `user@host` form first (e.g. brigade@192.168.64.3).
		const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
		if (userHostMatch) return userHostMatch[1];
		// Fallback: host-only token immediately before the imsg command.
		const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
		return hostOnlyMatch?.[1];
	} catch {
		return undefined;
	}
}

/* ───────────────────────── scp copy ───────────────────────── */

/** TEST SEAM: run `scp <remote> <local>` (defaults to spawning real `scp`). */
export type ScpRunner = (args: { remoteHost: string; remotePath: string; localPath: string }) => Promise<void>;

/** Spawn a real `scp` and resolve on exit 0, reject otherwise. */
const defaultScpRunner: ScpRunner = ({ remoteHost, remotePath, localPath }) =>
	new Promise<void>((resolve, reject) => {
		// `-T` disables pseudo-terminal allocation; `--` ends option parsing so a
		// crafted path can't be read as a flag. The host is already host-validated.
		const child = spawn("scp", ["-T", "--", `${remoteHost}:${remotePath}`, localPath], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`scp exited (code ${code ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
		});
	});

/** TEST SEAM: make a temp dir (defaults to fs `mkdtemp` under the OS temp dir). */
export type MkdtempLike = (prefix: string) => Promise<string>;

const defaultMkdtemp: MkdtempLike = (prefix) => mkdtemp(prefix);

/** Options for {@link scpCopyRemoteAttachment}. */
export interface ScpCopyArgs {
	/** Validated remote host (`user@host` / `host`). */
	remoteHost: string;
	/** Remote attachment path (already checked against the allowed remote roots). */
	remotePath: string;
	/** TEST SEAM: scp runner. */
	scpRunner?: ScpRunner;
	/** TEST SEAM: temp-dir factory. */
	mkdtempImpl?: MkdtempLike;
}

/**
 * Copy a remote attachment to a local temp file and return the local path.
 * Throws on scp failure (the caller treats it as "attachment unavailable").
 */
export async function scpCopyRemoteAttachment(args: ScpCopyArgs): Promise<string> {
	const runner = args.scpRunner ?? defaultScpRunner;
	const makeTemp = args.mkdtempImpl ?? defaultMkdtemp;
	const dir = await makeTemp(path.join(os.tmpdir(), "brigade-imsg-"));
	const localPath = path.join(dir, path.basename(args.remotePath) || "attachment");
	await runner({ remoteHost: args.remoteHost, remotePath: args.remotePath, localPath });
	return localPath;
}
