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
 *   brigade convex stop      — terminate the backend + dashboard started by a
 *                              previous `dev`/`start`, via its pidfile.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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

/** True if a process with this pid exists (EPERM still means it's alive). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Probe the backend's /version endpoint; true if it answers OK within 2s. */
async function probeRunning(host: string, port: number): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2_000);
	try {
		const res = await fetch(`http://${host}:${port}/version`, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

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
		// `dev`/`start` drop a pidfile (scripts/convex-dev.mjs) recording the
		// orchestrator + backend pids. Read it and terminate them directly —
		// safe and precise (no port-scanning, no killing arbitrary processes).
		const pidFile = join(dataDir, "convex.pid");

		if (!existsSync(pidFile)) {
			// No pidfile — either nothing is running, or it was started some other
			// way. Probe so we report accurately instead of guessing.
			const host = opts.host ?? DEFAULT_HOST;
			const port = opts.port ?? DEFAULT_PORT;
			if (await probeRunning(host, port)) {
				process.stdout.write(
					`Convex is running on ${host}:${port}, but no pidfile was found ` +
						`(${friendlyPath(pidFile)}).\n` +
						`It was likely started directly in a terminal — stop it there with Ctrl-C.\n`,
				);
				return 1;
			}
			process.stdout.write("Convex is not running.\n");
			return 0;
		}

		let info: { orchestratorPid?: number; backendPid?: number };
		try {
			info = JSON.parse(readFileSync(pidFile, "utf8"));
		} catch {
			process.stderr.write(
				`Could not parse pidfile ${friendlyPath(pidFile)} — delete it and retry.\n`,
			);
			return 1;
		}

		// Kill the backend first, then the orchestrator (which serves the
		// dashboard). On POSIX the orchestrator handles SIGTERM gracefully; on
		// Windows the signal hard-terminates — either way both end up stopped.
		const pids = [info.backendPid, info.orchestratorPid].filter(
			(p): p is number => typeof p === "number" && p > 0,
		);
		let killedAny = false;
		for (const pid of pids) {
			if (!isAlive(pid)) continue;
			try {
				process.kill(pid, "SIGTERM");
				killedAny = true;
			} catch (err) {
				process.stderr.write(`Failed to stop pid ${pid}: ${(err as Error).message}\n`);
			}
		}

		try {
			unlinkSync(pidFile);
		} catch {
			/* best-effort — the orchestrator removes it on its own shutdown too */
		}

		process.stdout.write(
			killedAny
				? "Stopped Convex (backend + dashboard).\n"
				: "Convex was not running (cleared a stale pidfile).\n",
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
