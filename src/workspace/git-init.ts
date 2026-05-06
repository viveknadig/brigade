import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { fileExists } from "./fs-utils.js";

// Initialise a git repo inside the workspace dir on first onboard so the
// user gets persona-file change history for free. Bounded behaviour:
//
//   - Only runs when the workspace looks freshly created (no `.git/` yet).
//   - Soft-fails if `git` isn't installed or `git init` exits non-zero —
//     workspace seeding shouldn't break because the user's machine has
//     no git binary, and the agent loop doesn't depend on git tracking.
//   - Doesn't touch existing repos (early return on `.git/` presence).

const GIT_PROBE_TIMEOUT_MS = 3_000;
const GIT_INIT_TIMEOUT_MS = 10_000;

let cachedGitAvailable: boolean | undefined;

export async function ensureWorkspaceGitRepo(workspaceDir: string): Promise<{
  initialised: boolean;
  reason?: "already-init" | "git-not-available" | "init-failed";
}> {
  if (await fileExists(path.join(workspaceDir, ".git"))) {
    return { initialised: false, reason: "already-init" };
  }
  if (!(await isGitAvailable())) {
    return { initialised: false, reason: "git-not-available" };
  }
  try {
    await runWithTimeout("git", ["init"], { cwd: workspaceDir, timeoutMs: GIT_INIT_TIMEOUT_MS });
  } catch {
    return { initialised: false, reason: "init-failed" };
  }
  // Drop a default .gitignore so the lifecycle marker dir doesn't get
  // committed by accident — the workspace-state.json file is per-host
  // state, not persona content.
  await fs.writeFile(
    path.join(workspaceDir, ".gitignore"),
    [".brigade/", "memory/.dreams/", ""].join("\n"),
    "utf8",
  );
  return { initialised: true };
}

async function isGitAvailable(): Promise<boolean> {
  if (cachedGitAvailable !== undefined) return cachedGitAvailable;
  try {
    await runWithTimeout("git", ["--version"], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    cachedGitAvailable = true;
  } catch {
    cachedGitAvailable = false;
  }
  return cachedGitAvailable;
}

interface RunOptions {
  cwd?: string;
  timeoutMs: number;
}

async function runWithTimeout(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "ignore",
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
