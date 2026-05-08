/**
 * `brigade config <list|get|set|unset|file>` — config CRUD over brigade.json.
 * Brigade-shape mirror of openclaw's `openclaw config <get|set|unset|file|...>`
 * (`src/cli/config-cli.ts`). The big differences:
 *
 *   - 4 subcommands instead of 6 (no `schema` / `validate` — Brigade's
 *     TypeBox schema is private and validation happens automatically on
 *     every write through `writeBrigadeConfig`).
 *   - Dot-notation only (no `path[0]` array indexing) — Brigade's super-
 *     config has no positional arrays the user would target by index.
 *   - JSON5 parsing for `set` values when --strict-json is off (numbers,
 *     booleans, arrays, objects) with raw-string fallback. Same shape as
 *     openclaw `parseValue` (`src/cli/config-cli.ts:163`).
 *   - Atomic write + 4-deep .bak rotation already inherited from
 *     `writeBrigadeConfig` — no extra wiring needed.
 *   - Secrets redaction in `list`/`get`: any segment matching
 *     /^(key|apiKey|token|password|secret)$/i (case-insensitive) renders
 *     as `__BRIGADE_REDACTED__`. Mirrors openclaw's REDACTED_SENTINEL
 *     pattern (`src/config/redact-snapshot.ts:93`).
 *
 * On-disk path: `~/.brigade/brigade.json` (resolved via BRIGADE_DIR).
 */

import * as path from "node:path";

import chalk from "chalk";
import type { Command } from "commander";
import JSON5 from "json5";

import {
	BrigadeConfigSchema,
	BRIGADE_CONFIG_FILENAME,
	collectBrigadeConfigErrors,
} from "../../core/brigade-config.js";
import { BRIGADE_DIR, loadConfig, saveConfig } from "../../core/config.js";

const REDACTED_SENTINEL = "__BRIGADE_REDACTED__";
// Case-insensitive match — segments that smell secret get their VALUE redacted
// in `list` and `get` output. The actual on-disk file is unchanged.
const SENSITIVE_SEGMENT = /^(key|apikey|token|secret|password|refreshtoken|accesstoken)$/i;

export interface ConfigGetOptions {
	json?: boolean;
}
export interface ConfigSetOptions {
	json?: boolean;
	strictJson?: boolean;
	dryRun?: boolean;
}
export interface ConfigListOptions {
	json?: boolean;
	noRedact?: boolean;
}

/* ───────────────────────── path helpers ───────────────────────── */

/**
 * Parse a config path into segments. Supports:
 *
 *   - dot-notation:        `agents.defaults.provider`
 *   - escaped dot:         `keys.foo\.bar`         → ["keys", "foo.bar"]
 *   - bracket array index: `agents.fallbacks[0]`   → ["agents", "fallbacks", "0"]
 *   - bracket literal key: `secrets.providers["my.vault"]` → ["secrets", "providers", "my.vault"]
 *
 * Mirrors openclaw's `parsePath` (`src/cli/config-cli.ts:111-161`) — bracket
 * support is the genuine ergonomic win (operators editing array slots in
 * `agents.defaults.model.fallbacks[]` shouldn't have to fall through to
 * `--strict-json` whole-array overwrites).
 */
function parsePath(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("config path is empty");
	}
	const segments: string[] = [];
	let buf = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		// Escape a literal dot inside a key.
		if (ch === "\\" && trimmed[i + 1] === ".") {
			buf += ".";
			i++;
			continue;
		}
		// Dot separator.
		if (ch === ".") {
			if (buf.length === 0) {
				throw new Error(`empty segment in config path "${raw}"`);
			}
			segments.push(buf);
			buf = "";
			continue;
		}
		// Bracket: either array index `[0]` or literal key `["foo.bar"]`.
		if (ch === "[") {
			if (buf.length > 0) {
				segments.push(buf);
				buf = "";
			}
			const close = trimmed.indexOf("]", i);
			if (close === -1) {
				throw new Error(`unclosed "[" in config path "${raw}"`);
			}
			let inside = trimmed.slice(i + 1, close).trim();
			// Strip optional surrounding quotes — accept both `[0]` and `["key"]`.
			if (
				(inside.startsWith('"') && inside.endsWith('"')) ||
				(inside.startsWith("'") && inside.endsWith("'"))
			) {
				inside = inside.slice(1, -1);
			}
			if (inside.length === 0) {
				throw new Error(`empty bracket segment in config path "${raw}"`);
			}
			segments.push(inside);
			i = close;
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) segments.push(buf);
	if (segments.length === 0) {
		throw new Error(`unable to parse config path "${raw}"`);
	}
	return segments;
}

/** True iff the segment looks like a non-negative integer (array index). */
function isIndexSegment(seg: string): boolean {
	return /^[0-9]+$/.test(seg);
}

function getNested(root: unknown, segments: string[]): unknown {
	let cur: unknown = root;
	for (const seg of segments) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur) && isIndexSegment(seg)) {
			cur = cur[Number(seg)];
			continue;
		}
		if (typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

function setNested(root: Record<string, unknown>, segments: string[], value: unknown): void {
	let cur: any = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i] ?? "";
		const nextSeg = segments[i + 1] ?? "";
		const wantArray = isIndexSegment(nextSeg);
		const existing = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur[seg];
		if (existing === undefined || existing === null || typeof existing !== "object") {
			// Create container in the right shape for the NEXT segment.
			const fresh = wantArray ? [] : {};
			if (Array.isArray(cur) && isIndexSegment(seg)) {
				cur[Number(seg)] = fresh;
			} else {
				cur[seg] = fresh;
			}
			cur = fresh;
		} else {
			cur = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur[seg];
		}
	}
	const tail = segments[segments.length - 1] ?? "";
	if (Array.isArray(cur) && isIndexSegment(tail)) {
		cur[Number(tail)] = value;
	} else {
		cur[tail] = value;
	}
}

function deleteNested(root: Record<string, unknown>, segments: string[]): boolean {
	let cur: any = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i] ?? "";
		const next = Array.isArray(cur) && isIndexSegment(seg) ? cur[Number(seg)] : cur?.[seg];
		if (next === undefined || next === null || typeof next !== "object") return false;
		cur = next;
	}
	const tail = segments[segments.length - 1] ?? "";
	if (Array.isArray(cur) && isIndexSegment(tail)) {
		const idx = Number(tail);
		if (idx < cur.length) {
			cur.splice(idx, 1); // shift down — matches array-mutation semantics
			return true;
		}
		return false;
	}
	if (cur && typeof cur === "object" && tail in cur) {
		delete cur[tail];
		return true;
	}
	return false;
}

/* ───────────────────────── value parsing ─────────────────────── */

function parseValue(raw: string, opts: { strictJson?: boolean } = {}): unknown {
	if (opts.strictJson) {
		return JSON.parse(raw);
	}
	try {
		return JSON5.parse(raw);
	} catch {
		// Fall through to raw string when JSON5 can't parse it.
		return raw;
	}
}

/* ───────────────────────── redaction ─────────────────────────── */

function redactDeep(value: unknown, segmentsParent: string[] = []): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, segmentsParent));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (SENSITIVE_SEGMENT.test(k) && typeof v === "string" && v.length > 0) {
			out[k] = REDACTED_SENTINEL;
		} else {
			out[k] = redactDeep(v, [...segmentsParent, k]);
		}
	}
	return out;
}

/* ───────────────────────── runtime ───────────────────────────── */

export async function runConfigGet(rawPath: string, opts: ConfigGetOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	const value = getNested(cfg, segments);
	if (value === undefined) {
		process.stderr.write(`brigade config: key "${rawPath}" not found\n`);
		return 1;
	}
	const redacted = redactDeep(value);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
	} else if (typeof redacted === "string" || typeof redacted === "number" || typeof redacted === "boolean") {
		process.stdout.write(`${redacted}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
	}
	return 0;
}

export async function runConfigSet(rawPath: string, rawValue: string, opts: ConfigSetOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	let parsed: unknown;
	try {
		parsed = parseValue(rawValue, { strictJson: opts.strictJson });
	} catch (err) {
		process.stderr.write(`brigade config: failed to parse value: ${(err as Error).message}\n`);
		return 1;
	}
	setNested(cfg as unknown as Record<string, unknown>, segments, parsed);
	if (opts.dryRun) {
		const preview = redactDeep(getNested(cfg, segments));
		process.stdout.write(
			`${chalk.dim("(dry-run, not written)")} ${rawPath} = ${JSON.stringify(preview)}\n`,
		);
		return 0;
	}
	saveConfig(cfg as never);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, path: rawPath, value: redactDeep(parsed) }, null, 2)}\n`);
	} else {
		process.stdout.write(
			`${chalk.green("set")} ${rawPath} = ${JSON.stringify(redactDeep(parsed))}\n`,
		);
	}
	return 0;
}

export async function runConfigUnset(rawPath: string, opts: { json?: boolean } = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const segments = parsePath(rawPath);
	const removed = deleteNested(cfg as unknown as Record<string, unknown>, segments);
	if (!removed) {
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, path: rawPath, reason: "not found" })}\n`);
		} else {
			process.stderr.write(`brigade config: key "${rawPath}" not found\n`);
		}
		return 1;
	}
	saveConfig(cfg as never);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, path: rawPath })}\n`);
	} else {
		process.stdout.write(`${chalk.yellow("unset")} ${rawPath}\n`);
	}
	return 0;
}

export async function runConfigList(opts: ConfigListOptions = {}): Promise<number> {
	const cfg = loadConfig() as Record<string, unknown>;
	const view = opts.noRedact ? cfg : redactDeep(cfg);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.dim(`# ${path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME)}`)}\n`);
		process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
	}
	return 0;
}

export async function runConfigFile(opts: { json?: boolean } = {}): Promise<number> {
	const filePath = path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ path: filePath })}\n`);
	} else {
		process.stdout.write(`${filePath}\n`);
	}
	return 0;
}

/**
 * Print the brigade.json TypeBox schema as JSON. Mirrors openclaw's
 * `openclaw config schema` (`src/cli/config-cli.ts:1265-1273`) — useful for
 * IDE / external-tool autocompletion against the live shape.
 *
 * The output is the in-memory TypeBox schema descriptor (with `type`,
 * `properties`, `required`, etc.) — JSON-Schema-compatible enough to feed
 * into a JSON-Schema-aware editor.
 */
export async function runConfigSchema(_opts: {} = {}): Promise<number> {
	process.stdout.write(`${JSON.stringify(BrigadeConfigSchema, null, 2)}\n`);
	return 0;
}

/**
 * Validate the on-disk brigade.json against the TypeBox schema. Reports a
 * pass/fail line plus per-issue path + message when invalid. Mirrors
 * openclaw's `openclaw config validate` (`src/cli/config-cli.ts:1275-1324`).
 *
 * Exit codes:
 *   0 — config is valid (or doesn't exist yet — empty file is benign)
 *   1 — config is invalid; issues listed
 */
export async function runConfigValidate(opts: { json?: boolean } = {}): Promise<number> {
	const filePath = path.join(BRIGADE_DIR, BRIGADE_CONFIG_FILENAME);
	let cfg: unknown;
	try {
		cfg = loadConfig();
	} catch (err) {
		const message = (err as Error).message;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ valid: false, path: filePath, error: message }, null, 2)}\n`);
		} else {
			process.stderr.write(`${chalk.red("✗")} couldn't read ${filePath}: ${message}\n`);
		}
		return 1;
	}

	const issues = collectBrigadeConfigErrors(cfg);

	if (issues.length === 0) {
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ valid: true, path: filePath }, null, 2)}\n`);
		} else {
			process.stdout.write(`${chalk.green("✓")} valid: ${filePath}\n`);
		}
		return 0;
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ valid: false, path: filePath, issues }, null, 2)}\n`,
		);
	} else {
		process.stderr.write(`${chalk.red("✗")} ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${filePath}:\n`);
		for (const issue of issues) {
			const where = issue.path || "(root)";
			process.stderr.write(`  ${chalk.dim("·")} ${chalk.yellow(where)}: ${issue.message}\n`);
		}
		process.stderr.write(`\n${chalk.dim("Tip: run `brigade config get <path>` to inspect a specific field.")}\n`);
	}
	return 1;
}

/* ───────────────────────── registration ──────────────────────── */

export function registerConfigCommand(program: Command): void {
	const cfgCmd = program.command("config").description("Read or modify brigade.json");

	cfgCmd
		.command("list")
		.description("Print the full config (secrets redacted)")
		.option("--json", "emit JSON only (no header)", false)
		.option("--no-redact", "show raw values including secrets (use carefully)", false)
		.action(async (opts: { json?: boolean; redact?: boolean }) => {
			const code = await runConfigList({ json: opts.json, noRedact: opts.redact === false });
			process.exit(code);
		});

	cfgCmd
		.command("get <path>")
		.description("Read a value by dot-notation key (e.g. agents.defaults.provider)")
		.option("--json", "emit JSON instead of bare-string output", false)
		.action(async (rawPath: string, opts: { json?: boolean }) => {
			const code = await runConfigGet(rawPath, { json: opts.json });
			process.exit(code);
		});

	cfgCmd
		.command("set <path> <value>")
		.description("Write a value (JSON5-parsed by default; falls back to string)")
		.option("--strict-json", "require strict JSON syntax for the value", false)
		.option("--dry-run", "show what would be written without persisting", false)
		.option("--json", "emit JSON status instead of human text", false)
		.action(async (rawPath: string, rawValue: string, opts: { strictJson?: boolean; dryRun?: boolean; json?: boolean }) => {
			const code = await runConfigSet(rawPath, rawValue, {
				strictJson: opts.strictJson,
				dryRun: opts.dryRun,
				json: opts.json,
			});
			process.exit(code);
		});

	cfgCmd
		.command("unset <path>")
		.description("Remove a key by dot-notation path")
		.option("--json", "emit JSON status instead of human text", false)
		.action(async (rawPath: string, opts: { json?: boolean }) => {
			const code = await runConfigUnset(rawPath, { json: opts.json });
			process.exit(code);
		});

	cfgCmd
		.command("file")
		.description("Print the absolute path to brigade.json")
		.option("--json", "emit JSON instead of bare-path output", false)
		.action(async (opts: { json?: boolean }) => {
			const code = await runConfigFile({ json: opts.json });
			process.exit(code);
		});
}
