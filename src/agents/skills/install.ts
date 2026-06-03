/**
 * Per-kind installer for `skills.install`.
 *
 * Each kind (`brew`, `node`, `go`, `uv`, `download`) maps to a small
 * `child_process.spawn` invocation (or a `fetch`+write for `download`).
 * The runner returns a structured result so the gateway handler can hand
 * the operator a JSON blob with stdout/stderr/exit code — no stdout
 * shell-out gymnastics. Tests inject a stub `spawn` via the optional
 * `deps.spawn` seam so the assertion can be "we asked npm to install the
 * right package" without a real child running.
 *
 * Out of scope here: ClawHub-style remote skill registries. The RPC is
 * intentionally limited to deterministic system-tool invocations + a
 * direct URL download so the surface stays auditable.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";

import { hasBinary } from "./eligibility.js";
import { SkillInstallSpec, type SkillInstallSpecKind } from "./install-spec.js";

/** What a child process produced — captured so the result is auditable. */
export interface ChildProcessResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Final result of `installSkill`. */
export interface InstallResult {
	ok: boolean;
	kind: SkillInstallSpecKind;
	command?: string;
	args?: string[];
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	message?: string;
	/** Absolute path of any file written by a `download` install. */
	downloadedTo?: string;
}

/** Minimal child-process handle the install runner reads. */
export interface InstallSpawnedChild {
	stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
	stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
	on(event: "error", cb: (err: Error) => void): InstallSpawnedChild;
	on(event: "close", cb: (code: number | null) => void): InstallSpawnedChild;
	stdin?: Writable | null;
}

/** Minimal `spawn` shape we depend on — keeps the test stub focused. */
export type SpawnLike = (
	command: string,
	args: ReadonlyArray<string>,
	options?: SpawnOptions,
) => InstallSpawnedChild;

/** Test seam — inject a stubbed `spawn` to assert the invocation. */
export interface InstallSkillDeps {
	spawn?: SpawnLike;
	/** Override `fetch` for `download` installs (tests). */
	fetchImpl?: typeof fetch;
	/** Override the `hasBinary` probe (tests). */
	hasBinaryImpl?: (name: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

async function runProcess(
	command: string,
	args: ReadonlyArray<string>,
	deps: InstallSkillDeps,
	timeoutMs: number,
): Promise<ChildProcessResult> {
	const spawnFn: SpawnLike = (deps.spawn ?? (nodeSpawn as unknown as SpawnLike));
	return await new Promise<ChildProcessResult>((resolve) => {
		const child = spawnFn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (result: ChildProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			settle({
				ok: false,
				exitCode: null,
				stdout,
				stderr: stderr + `\n[brigade-install] timed out after ${timeoutMs}ms`,
			});
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on("error", (err: Error) => {
			settle({ ok: false, exitCode: null, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message });
		});
		child.on("close", (code: number | null) => {
			settle({ ok: code === 0, exitCode: code, stdout, stderr });
		});
	});
}

function resolveTarget(spec: SkillInstallSpec, field: keyof SkillInstallSpec): string | undefined {
	const fromField = spec[field];
	if (typeof fromField === "string" && fromField.trim().length > 0) return fromField.trim();
	const fromTarget = spec.target;
	if (typeof fromTarget === "string" && fromTarget.trim().length > 0) return fromTarget.trim();
	return undefined;
}

/**
 * Install one skill spec. Caller is responsible for any user-facing
 * confirmation; this function just shells out (or downloads).
 */
export async function installSkill(
	spec: SkillInstallSpec,
	deps: InstallSkillDeps = {},
	options: { timeoutMs?: number } = {},
): Promise<InstallResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const probe = deps.hasBinaryImpl ?? hasBinary;
	switch (spec.kind) {
		case "brew": {
			const formula = resolveTarget(spec, "formula");
			if (!formula) return { ok: false, kind: spec.kind, message: "brew install: missing formula/target" };
			if (!probe("brew"))
				return {
					ok: false,
					kind: spec.kind,
					message: "brew binary not on PATH — install Homebrew first",
				};
			const res = await runProcess("brew", ["install", formula], deps, timeoutMs);
			return {
				ok: res.ok,
				kind: spec.kind,
				command: "brew",
				args: ["install", formula],
				stdout: res.stdout,
				stderr: res.stderr,
				exitCode: res.exitCode,
				...(res.ok ? {} : { message: `brew install ${formula} failed (code ${res.exitCode})` }),
			};
		}
		case "node": {
			const pkg = resolveTarget(spec, "package");
			if (!pkg) return { ok: false, kind: spec.kind, message: "node install: missing package/target" };
			if (!probe("npm"))
				return {
					ok: false,
					kind: spec.kind,
					message: "npm binary not on PATH — install Node.js first",
				};
			const res = await runProcess("npm", ["install", "-g", pkg], deps, timeoutMs);
			return {
				ok: res.ok,
				kind: spec.kind,
				command: "npm",
				args: ["install", "-g", pkg],
				stdout: res.stdout,
				stderr: res.stderr,
				exitCode: res.exitCode,
				...(res.ok ? {} : { message: `npm install -g ${pkg} failed (code ${res.exitCode})` }),
			};
		}
		case "go": {
			const module = resolveTarget(spec, "module");
			if (!module) return { ok: false, kind: spec.kind, message: "go install: missing module/target" };
			if (!probe("go"))
				return {
					ok: false,
					kind: spec.kind,
					message: "go binary not on PATH — install the Go toolchain first",
				};
			const res = await runProcess("go", ["install", module], deps, timeoutMs);
			return {
				ok: res.ok,
				kind: spec.kind,
				command: "go",
				args: ["install", module],
				stdout: res.stdout,
				stderr: res.stderr,
				exitCode: res.exitCode,
				...(res.ok ? {} : { message: `go install ${module} failed (code ${res.exitCode})` }),
			};
		}
		case "uv": {
			const pkg = resolveTarget(spec, "package");
			if (!pkg) return { ok: false, kind: spec.kind, message: "uv install: missing package/target" };
			if (!probe("uv"))
				return {
					ok: false,
					kind: spec.kind,
					message: "uv binary not on PATH — install uv first",
				};
			const res = await runProcess("uv", ["pip", "install", pkg], deps, timeoutMs);
			return {
				ok: res.ok,
				kind: spec.kind,
				command: "uv",
				args: ["pip", "install", pkg],
				stdout: res.stdout,
				stderr: res.stderr,
				exitCode: res.exitCode,
				...(res.ok ? {} : { message: `uv pip install ${pkg} failed (code ${res.exitCode})` }),
			};
		}
		case "download": {
			const url = resolveTarget(spec, "url");
			if (!url) return { ok: false, kind: spec.kind, message: "download install: missing url/target" };
			const targetDir =
				typeof spec.targetDir === "string" && spec.targetDir.trim().length > 0
					? spec.targetDir.trim()
					: process.cwd();
			try {
				fs.mkdirSync(targetDir, { recursive: true });
				const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
				if (!fetchImpl) {
					return { ok: false, kind: spec.kind, message: "fetch is unavailable in this runtime" };
				}
				const response = await fetchImpl(url);
				if (!response.ok) {
					return {
						ok: false,
						kind: spec.kind,
						message: `download ${url} failed: HTTP ${response.status}`,
					};
				}
				const buffer = Buffer.from(await response.arrayBuffer());
				const basename = path.basename(new URL(url).pathname) || "downloaded";
				const dest = path.join(targetDir, basename);
				fs.writeFileSync(dest, buffer);
				return { ok: true, kind: spec.kind, downloadedTo: dest };
			} catch (err) {
				return {
					ok: false,
					kind: spec.kind,
					message: `download ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		default: {
			const exhaustive: never = spec.kind;
			return { ok: false, kind: spec.kind, message: `unknown install kind: ${String(exhaustive)}` };
		}
	}
}
