// src/cli/commands/store-cmd.ts
//
// `brigade store mode show|set` — operator-facing CLI for inspecting and
// flipping the storage-mode sentinel without re-running `brigade onboard`.
//
// Read path: parses `~/.brigade/mode.sentinel`.
// Write path: writes the sentinel with `writeSentinelNow`. Idempotent.
//
// Migration ISN'T part of this command; flipping the sentinel just changes
// where Brigade will read/write on next boot. `brigade store migrate` (a
// later PR) handles the data copy.

import chalk from "chalk";
import type { Command } from "commander";

import { resolveStateDir } from "../../config/paths.js";
import { runStoreMigrate } from "../../storage/migrate.js";
import { readSentinel, sentinelExists, writeSentinelNow } from "../../storage/sentinel.js";
import type { StorageMode } from "../../storage/runtime-context.js";

export interface StoreModeShowOptions {
	json?: boolean;
}

export interface StoreModeSetOptions {
	mode: string;
	convexUrl?: string;
	json?: boolean;
}

// ---------------------------------------------------------------------------
// brigade store mode show
// ---------------------------------------------------------------------------

export async function runStoreModeShow(opts: StoreModeShowOptions = {}): Promise<number> {
	let sentinel;
	try {
		sentinel = readSentinel();
	} catch (err) {
		const msg = (err as Error).message;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		} else {
			process.stderr.write(chalk.red(`brigade store mode show: ${msg}\n`));
		}
		return 1;
	}

	if (!sentinel) {
		const message = "filesystem (default — no mode.sentinel pinned yet)";
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, mode: "filesystem", pinned: false }, null, 2)}\n`,
			);
		} else {
			process.stdout.write(`${chalk.bold("Storage mode:")} ${chalk.bold("filesystem")}\n`);
			process.stdout.write(chalk.dim(`  ${message}\n`));
			process.stdout.write(
				chalk.dim(`  Pin it with: brigade store mode set filesystem (or convex --convex-url <url>)\n`),
			);
		}
		return 0;
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, mode: sentinel.mode, pinned: true, sentinel }, null, 2)}\n`,
		);
		return 0;
	}

	process.stdout.write(`${chalk.bold("Storage mode:")} ${chalk.bold(sentinel.mode)}\n`);
	if (sentinel.mode === "convex") {
		process.stdout.write(chalk.dim(`  Convex URL:   ${sentinel.convexUrl}\n`));
	}
	if (sentinel.migratedAt) {
		process.stdout.write(chalk.dim(`  Pinned at:    ${sentinel.migratedAt}\n`));
	}
	if (sentinel.manifestSha256) {
		process.stdout.write(chalk.dim(`  Manifest:     ${sentinel.manifestSha256}\n`));
	}
	return 0;
}

// ---------------------------------------------------------------------------
// brigade store mode set <mode>
// ---------------------------------------------------------------------------

export async function runStoreModeSet(opts: StoreModeSetOptions): Promise<number> {
	const mode = opts.mode.trim();
	if (mode !== "filesystem" && mode !== "convex") {
		const msg = `mode must be "filesystem" or "convex", got "${mode}"`;
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		} else {
			process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
		}
		return 1;
	}

	if (mode === "convex") {
		const url = opts.convexUrl?.trim();
		if (!url || url.length === 0) {
			const msg = "convex mode requires --convex-url <http(s)://...>";
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
			} else {
				process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
			}
			return 1;
		}
		if (!/^https?:\/\//i.test(url)) {
			const msg = `convex URL must start with http:// or https://, got "${url}"`;
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
			} else {
				process.stderr.write(chalk.red(`brigade store mode set: ${msg}\n`));
			}
			return 1;
		}
	}

	const existed = sentinelExists();
	const sentinel = writeSentinelNow(mode as StorageMode, {
		...(opts.convexUrl ? { convexUrl: opts.convexUrl.trim() } : {}),
	});

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, mode: sentinel.mode, previouslyPinned: existed, sentinel }, null, 2)}\n`,
		);
		return 0;
	}

	process.stdout.write(`${chalk.green("✓")} storage mode pinned to ${chalk.bold(sentinel.mode)}\n`);
	if (sentinel.mode === "convex") {
		process.stdout.write(chalk.dim(`  Convex URL:  ${sentinel.convexUrl}\n`));
	}
	if (!existed) {
		process.stdout.write(
			chalk.dim(`  This is a fresh pin. To migrate existing data between modes use:\n`),
		);
		process.stdout.write(
			chalk.dim(`    brigade store migrate --to ${sentinel.mode}  (not yet shipped — Phase 2 PR17)\n`),
		);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// brigade store migrate --to <mode>
// ---------------------------------------------------------------------------

export interface StoreMigrateOptions {
	to: string;
	convexUrl?: string;
	dryRun?: boolean;
	skipVerify?: boolean;
	json?: boolean;
}

export async function runStoreMigrateCmd(opts: StoreMigrateOptions): Promise<number> {
	const to = opts.to.trim();
	if (to !== "filesystem" && to !== "convex") {
		const msg = `--to must be "filesystem" or "convex", got "${to}"`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
		else process.stderr.write(chalk.red(`brigade store migrate: ${msg}\n`));
		return 1;
	}

	const report = await runStoreMigrate({
		to: to as StorageMode,
		stateDir: resolveStateDir(),
		...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
		...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
		...(opts.skipVerify !== undefined ? { skipVerify: opts.skipVerify } : {}),
		onProgress: opts.json
			? undefined
			: (e) => {
					if (e.phase === "done") {
						process.stdout.write(
							chalk.dim(`  ${e.domain.padEnd(16)} ${e.count ?? 0} item${e.count === 1 ? "" : "s"}\n`),
						);
					} else if (e.phase === "skip") {
						process.stdout.write(chalk.yellow(`  ${e.domain.padEnd(16)} skipped: ${e.note}\n`));
					}
				},
	});

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
		return 0;
	}

	const total = report.domains.reduce((acc, d) => acc + d.copied, 0);
	const skipped = report.domains.filter((d) => d.skipped).length;
	process.stdout.write(
		`\n${chalk.green("✓")} migrated ${chalk.bold(report.from)} → ${chalk.bold(report.to)} · ` +
			`${chalk.bold(String(total))} items across ${report.domains.length} domains · ` +
			`${report.durationMs}ms\n`,
	);
	if (skipped > 0) {
		process.stdout.write(chalk.yellow(`  ${skipped} domain${skipped === 1 ? "" : "s"} reported errors (see above)\n`));
	}
	if (report.dryRun) {
		process.stdout.write(chalk.dim(`  --dry-run: no data was written, no sentinel flipped\n`));
	} else if (report.sentinelWritten) {
		process.stdout.write(chalk.dim(`  ~/.brigade/mode.sentinel now points to ${report.to}\n`));
	} else {
		process.stdout.write(
			chalk.yellow(`  ⚠ sentinel write failed — flip manually with brigade store mode set ${report.to}\n`),
		);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export function registerStoreCommand(program: Command): void {
	const store = program
		.command("store")
		.description("Inspect or flip Brigade's storage backend (filesystem / convex)");

	const mode = store.command("mode").description("Manage the storage-mode sentinel");

	mode
		.command("show")
		.description("Print the active storage mode (and Convex URL if applicable)")
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (opts: { json?: boolean }) => {
			process.exit(await runStoreModeShow({ json: opts.json }));
		});

	mode
		.command("set <mode>")
		.description(
			"Pin the storage mode for this machine.\n" +
				"  Examples:\n" +
				"    brigade store mode set filesystem\n" +
				"    brigade store mode set convex --convex-url http://127.0.0.1:3210",
		)
		.option("--convex-url <url>", "deployment URL (required when <mode> is convex)")
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(async (modeArg: string, opts: { convexUrl?: string; json?: boolean }) => {
			process.exit(
				await runStoreModeSet({
					mode: modeArg,
					...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
				}),
			);
		});

	store
		.command("migrate")
		.description(
			"Copy your Brigade data between storage backends.\n" +
				"  Examples:\n" +
				"    brigade store migrate --to convex --convex-url http://127.0.0.1:3210\n" +
				"    brigade store migrate --to filesystem\n" +
				"    brigade store migrate --to convex --dry-run\n",
		)
		.requiredOption("--to <mode>", "destination mode: filesystem | convex")
		.option("--convex-url <url>", "deployment URL (used when migrating to/from convex)")
		.option("--dry-run", "report what would be copied without writing", false)
		.option("--skip-verify", "skip sha256 verification (faster, less safe)", false)
		.option("--json", "emit JSON instead of human-readable text", false)
		.action(
			async (opts: {
				to: string;
				convexUrl?: string;
				dryRun?: boolean;
				skipVerify?: boolean;
				json?: boolean;
			}) => {
				process.exit(
					await runStoreMigrateCmd({
						to: opts.to,
						...(opts.convexUrl !== undefined ? { convexUrl: opts.convexUrl } : {}),
						...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
						...(opts.skipVerify !== undefined ? { skipVerify: opts.skipVerify } : {}),
						...(opts.json !== undefined ? { json: opts.json } : {}),
					}),
				);
			},
		);
}
