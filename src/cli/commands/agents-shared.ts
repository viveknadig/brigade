/**
 * Shared runtime helpers for the `brigade agents <...>` CRUD subcommands.
 * Brand-scrubbed analogue of the reference codebase's
 * `src/commands/agents.command-shared.ts`.
 *
 * Brigade does not yet ship a schema validator with rich issue diagnostics
 * (the reference's `requireValidConfigFileSnapshot` returns a list of
 * formatted issues). v1 here delegates to `loadConfig()` and surfaces a
 * single parse-failure error to stderr — once `brigade doctor` schema-
 * validate ships the issue-list branch lands.
 */

import { resolveConfigPath } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import type { BrigadeConfig } from "../../config/io.js";

/** Console-like surface so command runners can swap a quiet sink in JSON mode. */
export interface CommandRuntime {
	log: (message: string) => void;
	error: (message: string) => void;
	warn: (message: string) => void;
}

/** Default runtime — writes to stdout / stderr. */
export const defaultRuntime: CommandRuntime = {
	log: (message) => {
		process.stdout.write(`${message}\n`);
	},
	error: (message) => {
		process.stderr.write(`${message}\n`);
	},
	warn: (message) => {
		process.stderr.write(`${message}\n`);
	},
};

/**
 * Return a clone of the given runtime whose `log` calls are silenced. The
 * `error` / `warn` channels stay live so validation failures and surprises
 * still reach the operator (and stderr does not pollute --json output).
 */
export function createQuietRuntime(runtime: CommandRuntime = defaultRuntime): CommandRuntime {
	return {
		...runtime,
		log: () => {},
	};
}

/** Minimal snapshot returned by the snapshot variant (parse failures included). */
export interface ConfigFileSnapshot {
	/** True iff brigade.json exists on disk. */
	exists: boolean;
	/** True iff the file parsed cleanly. */
	valid: boolean;
	/** Parsed config (null when parse failed). */
	config: BrigadeConfig | null;
	/** Resolved absolute path to brigade.json. */
	path: string;
	/** Human-readable issues (single-element on parse failure). */
	issues: string[];
}

/**
 * Load brigade.json + report parse status without exiting. Callers decide
 * whether a missing file is fatal — onboard / first-run flows tolerate it,
 * CRUD subcommands typically don't.
 */
export async function requireValidConfigFileSnapshot(
	runtime: CommandRuntime = defaultRuntime,
): Promise<ConfigFileSnapshot> {
	const cfgPath = resolveConfigPath();
	const fs = await import("node:fs");
	const exists = fs.existsSync(cfgPath);
	let parsed: BrigadeConfig | null = null;
	const issues: string[] = [];
	try {
		parsed = loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		issues.push(`Failed to parse brigade.json: ${message}`);
	}
	if (issues.length > 0) {
		runtime.error(`Config invalid:\n- ${issues.join("\n- ")}`);
		runtime.error("Fix the config or run `brigade doctor`.");
	}
	return {
		exists,
		valid: issues.length === 0,
		config: issues.length === 0 ? parsed : null,
		path: cfgPath,
		issues,
	};
}

/**
 * Exit-on-fail wrapper around `loadConfig()`. Returns the parsed BrigadeConfig
 * on success; on parse failure prints diagnostics + returns null. Per the
 * lifted contract, callers decide whether to surface a non-zero exit — this
 * helper deliberately does NOT call `process.exit`.
 *
 * When the file does not exist yet (fresh install), `loadConfig` returns the
 * empty `{ agents: {} }` stub — callers treat that as a valid (but empty)
 * config.
 */
export async function requireValidConfig(
	runtime: CommandRuntime = defaultRuntime,
): Promise<BrigadeConfig | null> {
	const snap = await requireValidConfigFileSnapshot(runtime);
	if (!snap.valid) return null;
	return snap.config;
}
