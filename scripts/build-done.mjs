#!/usr/bin/env node
/**
 * Postbuild banner. `tsc` prints nothing on a successful build, so this runs
 * via the `postbuild` npm lifecycle hook (fires automatically after `build`)
 * to confirm the build finished and point at what to run next.
 *
 * Cosmetic only — wrapped so it can NEVER fail the build, and colour-aware
 * (chalk auto-disables on non-TTY / NO_COLOR, so piped/CI output stays clean).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import chalk from "chalk";

const GOLD = "#fbbf24"; // Brigade amber — matches src/ui/theme.ts

/** Count compiled .js files in dist/ as a light "what got built" signal. */
function countJs(dir) {
	let n = 0;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		if (e.isDirectory()) n += countJs(join(dir, e.name));
		else if (e.name.endsWith(".js")) n++;
	}
	return n;
}

try {
	const gold = chalk.hex(GOLD);
	const files = countJs("dist");
	const count = files > 0 ? ` (${files} files)` : "";
	process.stdout.write(
		`\n${gold.bold("✓ Build complete")}${chalk.dim(` — dist/ ready${count}.`)}\n` +
			`${chalk.dim("  Run:")} ${gold("brigade")}${chalk.dim(" chat · ")}${gold("brigade gateway")}${chalk.dim(" daemon · ")}${gold("brigade onboard")}${chalk.dim(" setup")}\n\n`,
	);
} catch {
	// Banner is purely cosmetic — never let it fail the build.
}
