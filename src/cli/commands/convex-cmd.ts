/**
 * `brigade convex <dev|start|status|stop|push|codegen>` — drive the bundled
 * self-hosted Convex backend that powers Brigade's convex storage mode.
 *
 * Brigade ships the Convex backend + dashboard binaries and the orchestrator
 * scripts inside the package, so this works both from a repo checkout and from
 * a global `npm i -g` install (any cwd). The actual work lives in the
 * `scripts/*.mjs` orchestrators; this command resolves the package root + the
 * per-user bin/data directories, exports them as env vars, and spawns the
 * right script so the scripts behave identically in either layout.
 *
 *   brigade convex dev       — install binaries if missing, then boot the
 *                              backend + dashboard in the foreground (Ctrl-C
 *                              to stop). `start` is an alias.
 *   brigade convex status    — probe the backend and report running / not.
 *   brigade convex push      — deploy the bundled convex/ functions.
 *   brigade convex codegen   — regenerate the convex/_generated client.
 *   brigade convex stop      — reminder that `dev` is foreground (Ctrl-C).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	resolvePackageRoot,
	resolveConvexBinDir,
	resolveConvexDataDir,
} from "../../config/paths.js";

export interface ConvexCommandOptions {
	action: "dev" | "start" | "status" | "stop" | "push" | "codegen";
	host?: string;
	port?: number;
	json?: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const DASHBOARD_PORT = 6791;

/** Friendly rendering of a data dir — collapses $HOME to ~ for the boot note. */
function friendlyPath(p: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

export async function runConvexCommand(opts: ConvexCommandOptions): Promise<number> {
	const pkgRoot = resolvePackageRoot();
	const binDir = resolveConvexBinDir();
	const dataDir = resolveConvexDataDir();

	// Hand the resolved locations to the orchestrator scripts so they behave the
	// same from a repo checkout and a global install.
	const env = {
		...process.env,
		BRIGADE_CONVEX_BIN_DIR: binDir,
		BRIGADE_CONVEX_DATA_DIR: dataDir,
		BRIGADE_PACKAGE_ROOT: pkgRoot,
	};

	if (opts.action === "dev" || opts.action === "start") {
		// 1) Ensure the backend + dashboard binaries are present (no-op when
		//    already downloaded). Fail fast if the install step errors.
		const install = spawnSync(process.execPath, [join(pkgRoot, "scripts", "install-convex.mjs")], {
			env,
			stdio: "inherit",
		});
		if (install.status !== 0) return 1;

		// 2) Boot the backend + dashboard in the foreground.
		process.stdout.write(
			`Starting Convex (data: ${friendlyPath(dataDir)})\n` +
				`  backend   → http://${DEFAULT_HOST}:${DEFAULT_PORT}\n` +
				`  dashboard → http://${DEFAULT_HOST}:${DASHBOARD_PORT}\n` +
				`  Press Ctrl-C to stop.\n\n`,
		);

		const child = spawn(process.execPath, [join(pkgRoot, "scripts", "convex-dev.mjs")], {
			env,
			stdio: "inherit",
		});

		// Forward termination signals so Ctrl-C / SIGTERM reach the orchestrator
		// (it owns the backend process + dashboard server and shuts them down
		// gracefully). The orchestrator exits on the signal; we resolve with its
		// exit code below.
		const forward = (sig: NodeJS.Signals) => {
			try {
				child.kill(sig);
			} catch {
				/* child already gone */
			}
		};
		const onSigint = () => forward("SIGINT");
		const onSigterm = () => forward("SIGTERM");
		process.on("SIGINT", onSigint);
		process.on("SIGTERM", onSigterm);

		return await new Promise<number>((resolveProm) => {
			child.on("exit", (code) => {
				process.off("SIGINT", onSigint);
				process.off("SIGTERM", onSigterm);
				resolveProm(code ?? 0);
			});
			child.on("error", () => {
				process.off("SIGINT", onSigint);
				process.off("SIGTERM", onSigterm);
				resolveProm(1);
			});
		});
	}

	if (opts.action === "push") {
		return (
			spawnSync(process.execPath, [join(pkgRoot, "scripts", "convex-push.mjs")], {
				env,
				stdio: "inherit",
			}).status ?? 1
		);
	}

	if (opts.action === "status") {
		const host = opts.host ?? DEFAULT_HOST;
		const port = opts.port ?? DEFAULT_PORT;
		const url = `http://${host}:${port}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2_000);
		try {
			const res = await fetch(`${url}/version`, { signal: controller.signal });
			clearTimeout(timer);
			if (!res.ok) {
				if (opts.json) {
					process.stdout.write(`${JSON.stringify({ running: false, url, status: res.status })}\n`);
				} else {
					process.stdout.write(`Convex is not running on ${host}:${port}\n`);
				}
				return 1;
			}
			const version = (await res.text()).trim();
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ running: true, url, version })}\n`);
			} else {
				process.stdout.write(`Convex is running on ${url} (version ${version || "unknown"})\n`);
			}
			return 0;
		} catch {
			clearTimeout(timer);
			if (opts.json) {
				process.stdout.write(`${JSON.stringify({ running: false, url })}\n`);
			} else {
				process.stdout.write(`Convex is not running on ${host}:${port}\n`);
			}
			return 1;
		}
	}

	if (opts.action === "stop") {
		// Kept deliberately simple + safe: `brigade convex dev` runs in the
		// foreground, so there's no daemon PID to signal. Killing arbitrary
		// processes by port would be unsafe; tell the operator how to stop it.
		process.stdout.write(
			"`brigade convex dev` runs in the foreground — stop it with Ctrl-C in its terminal.\n",
		);
		return 0;
	}

	if (opts.action === "codegen") {
		const keyFile = join(dataDir, "admin-key.txt");
		if (!existsSync(keyFile)) {
			process.stderr.write("No Convex backend found — run `brigade convex dev` first.\n");
			return 1;
		}
		const key = readFileSync(keyFile, "utf8").trim();
		return (
			spawnSync(
				"npx",
				["convex", "codegen", "--admin-key", key, "--url", `http://${DEFAULT_HOST}:${DEFAULT_PORT}`],
				{
					cwd: pkgRoot,
					env,
					stdio: "inherit",
					shell: process.platform === "win32", // resolves npx.cmd on Windows
				},
			).status ?? 1
		);
	}

	// Exhaustive — every action is handled above.
	return 1;
}
