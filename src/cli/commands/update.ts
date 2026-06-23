/**
 * `brigade update` (alias `upgrade`) — pull the latest published Brigade from
 * npm and report old → new version.
 *
 * Brigade ships as the global npm package `@spinabot/brigade`, so "updating" is
 * just `npm i -g <pkg>@latest`. This command wraps that with: current-vs-latest
 * version reporting, an `--check` dry-run, a "no `npm` on PATH" guard, and a
 * source-checkout detector — running it from a dev clone would install a SECOND,
 * conflicting global copy, so we refuse and print the git workflow instead.
 *
 * After a successful upgrade the running gateway daemon is still on the OLD
 * code, so we remind the operator to `brigade gateway restart`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

const FALLBACK_PKG = "@spinabot/brigade";

interface PackageInfo {
	name: string;
	version: string;
	root: string;
}

/** Walk up from this module to the package.json that owns it. */
function resolvePackageInfo(): PackageInfo {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
				if (parsed.name) return { name: parsed.name, version: parsed.version ?? "0.0.0", root: dir };
			} catch {
				/* keep walking */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { name: FALLBACK_PKG, version: "0.0.0", root: dir };
}

/** A package directory that carries `.git` + `src/` is a dev checkout, not a
 *  global install — `npm i -g` from here would create a conflicting copy. */
function isSourceCheckout(root: string): boolean {
	return existsSync(join(root, ".git")) && existsSync(join(root, "src"));
}

/** `npm` is `npm.cmd` on Windows — `shell: true` lets the bare name resolve. */
function runNpm(args: string[], opts: { capture?: boolean } = {}): { code: number; stdout: string } {
	const res = spawnSync("npm", args, {
		shell: true,
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	return { code: res.status ?? 1, stdout: (res.stdout ?? "").trim() };
}

export async function runUpdateCommand(opts: { check?: boolean } = {}): Promise<number> {
	const pkg = resolvePackageInfo();

	// Refuse to npm-install over a working source tree — guide to git instead.
	if (isSourceCheckout(pkg.root)) {
		process.stdout.write(
			`${chalk.yellow("You're running Brigade from a source checkout")} (${pkg.root}).\n` +
				"Update it with git instead of npm:\n\n" +
				`  ${chalk.bold("git pull")}\n` +
				`  ${chalk.bold("npm install")}\n` +
				`  ${chalk.bold("npm run build")}\n` +
				`  ${chalk.bold("brigade gateway restart")}\n`,
		);
		return 0;
	}

	// Need npm on PATH for both the version probe and the install.
	if (runNpm(["--version"], { capture: true }).code !== 0) {
		process.stderr.write(
			`${chalk.red("✗ npm wasn't found on your PATH.")} Install Node.js (which bundles npm), then re-run, ` +
				`or update manually: ${chalk.bold(`npm i -g ${pkg.name}@latest`)}\n`,
		);
		return 1;
	}

	// Latest published version (best-effort — offline / registry hiccup is non-fatal).
	const view = runNpm(["view", pkg.name, "version"], { capture: true });
	const latest = view.code === 0 ? view.stdout.split("\n").pop()?.trim() : undefined;

	process.stdout.write(`${chalk.dim("current:")} ${pkg.version}${latest ? `   ${chalk.dim("latest:")} ${latest}` : ""}\n`);

	if (latest && latest === pkg.version) {
		process.stdout.write(`${chalk.green("✓ Already on the latest version.")}\n`);
		return 0;
	}

	if (opts.check) {
		if (latest) {
			process.stdout.write(
				`${chalk.yellow(`↑ ${pkg.version} → ${latest} available.`)} Run ${chalk.bold("brigade update")} to upgrade.\n`,
			);
		} else {
			process.stderr.write("Couldn't reach the npm registry to check the latest version.\n");
			return 1;
		}
		return 0;
	}

	// Do the upgrade — stream npm's output so the operator sees progress.
	process.stdout.write(`\n${chalk.dim(`$ npm i -g ${pkg.name}@latest`)}\n`);
	const install = runNpm(["i", "-g", `${pkg.name}@latest`]);
	if (install.code !== 0) {
		process.stderr.write(
			`\n${chalk.red("✗ Upgrade failed.")} If it's a permissions error, retry with elevated rights ` +
				`(sudo / an Administrator shell), or run: ${chalk.bold(`npm i -g ${pkg.name}@latest`)}\n`,
		);
		return install.code;
	}

	process.stdout.write(
		`\n${chalk.green("✓ Brigade updated.")} ` +
			`Restart the gateway to run the new code: ${chalk.bold("brigade gateway restart")}\n`,
	);
	return 0;
}
