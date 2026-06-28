/**
 * `brigade exec-node <script.cjs> [args…]` — run a Node script with Brigade's
 * OWN bundled libraries resolvable.
 *
 * WHY THIS EXISTS. Brigade bundles document/media libraries (`docx`, `exceljs`,
 * `pdf-lib`/`@cantoo/pdf-lib`, `pptxgenjs`, `fflate`, `jimp`, …) as real npm
 * dependencies. But when the agent runs a one-off script through the `bash`
 * tool, it runs from the agent's WORKSPACE cwd — which has no `node_modules` —
 * so `require("docx")` fails with MODULE_NOT_FOUND. This shim re-execs `node`
 * with `NODE_PATH` pointed at the directory that holds Brigade's installed
 * dependencies, so a skill-authored script can `require()` any bundled library
 * with zero install on the user's side. That is what lets the document SKILLS
 * reach the FULL capability of the libraries (custom styles, real formulas,
 * form-field creation, OOXML round-trip, …) instead of being capped at the
 * fixed `make_document`/`edit_document` tool schemas.
 *
 * Use CommonJS (`require`) in the script (name it `*.cjs`): `NODE_PATH` governs
 * CJS bare-specifier resolution. It is intentionally a thin pass-through to
 * `node` — it adds NO capability the `bash`+`node` path didn't already have
 * (it's still gated by the exec-approval list like any shell command); it only
 * fixes resolution.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/**
 * Locate the `node_modules` directory that contains Brigade's bundled
 * dependencies, by resolving one we KNOW is a direct dependency (`fflate`) and
 * trimming back to its `node_modules` root. Works for global, local, and
 * hoisted installs. Returns undefined if resolution fails (caller proceeds
 * without NODE_PATH and the script simply won't see the bundled libs).
 */
export function resolveBundledNodeModules(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const resolved = require.resolve("fflate");
		const marker = `${path.sep}node_modules${path.sep}`;
		const idx = resolved.lastIndexOf(marker);
		if (idx >= 0) return resolved.slice(0, idx + marker.length - 1);
	} catch {
		/* fall through — undefined */
	}
	return undefined;
}

/**
 * Run `node` on the given script + args with Brigade's bundled `node_modules`
 * on NODE_PATH. Resolves with the child's exit code. Stdio is inherited so the
 * script's output flows straight back to the caller (and the agent).
 */
export async function runExecNodeCommand(scriptAndArgs: string[]): Promise<number> {
	if (scriptAndArgs.length === 0) {
		process.stderr.write(
			"usage: brigade exec-node <script.cjs> [args…]\n" +
				"  Runs a Node script with Brigade's bundled libs (docx, exceljs, pdf-lib, pptxgenjs, fflate, jimp) requireable.\n",
		);
		return 2;
	}
	const nm = resolveBundledNodeModules();
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (nm) {
		env.NODE_PATH = [nm, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
	}
	return await new Promise<number>((resolve) => {
		const child = spawn(process.execPath, scriptAndArgs, { stdio: "inherit", env });
		child.on("exit", (code) => resolve(code ?? 0));
		child.on("error", (err) => {
			process.stderr.write(`exec-node: ${(err as Error).message}\n`);
			resolve(1);
		});
	});
}
