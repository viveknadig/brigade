import fs from "node:fs/promises";
import path from "node:path";

import { tryLoadWorkspaceTemplate } from "./template-loader.js";
import { markBootstrapSeeded } from "./state.js";

// The 7 files a fresh brigade install drops into <agentDir>/workspace/.
// MEMORY.md is intentionally absent — it materialises lazily on the first
// dream cycle, not at onboard time.
//
// Content for each file lives on disk under templates/workspace/<name> so
// users can edit a single source-of-truth without recompiling. The loader
// resolves the templates dir lazily (package-root → cwd → fallback) and
// caches the result for the process lifetime.

export const WORKSPACE_FILE_NAMES = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "USER.md",
] as const;

export type WorkspaceFileName = (typeof WORKSPACE_FILE_NAMES)[number];

export interface BootstrapResult {
  workspaceDir: string;
  // Absolute paths of files this run created.
  created: string[];
  // Absolute paths of files that were already present (left untouched).
  preserved: string[];
  // Names of templates the loader couldn't find — surfaced so the caller
  // can warn the user that their templates dir is incomplete.
  missingTemplates: WorkspaceFileName[];
}

export async function bootstrapWorkspace(workspaceDir: string): Promise<BootstrapResult> {
  await fs.mkdir(workspaceDir, { recursive: true });
  // Create memory/ early so a partial failure in the persona-file loop
  // still leaves a usable workspace skeleton; the dream cycle populates
  // it lazily on first run.
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

  const created: string[] = [];
  const preserved: string[] = [];
  const missingTemplates: WorkspaceFileName[] = [];

  for (const name of WORKSPACE_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);

    const template = await tryLoadWorkspaceTemplate(name);
    if (!template) {
      missingTemplates.push(name);
      continue;
    }

    // flag:"wx" creates the file only if it doesn't exist. EEXIST means a
    // concurrent process (or a prior onboard run) wrote the file first —
    // preserve their copy rather than racing into a clobber.
    try {
      await fs.writeFile(filePath, template.content, {
        encoding: "utf-8",
        flag: "wx",
      });
      created.push(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        preserved.push(filePath);
        continue;
      }
      throw err;
    }
  }

  // Stamp the lifecycle marker if BOOTSTRAP.md is now on disk (whether
  // we just wrote it or it was already there). The agent kernel uses this
  // to decide whether the next turn is a first-run greeting or business
  // as usual.
  const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
  if (await fileExists(bootstrapPath)) {
    await markBootstrapSeeded(workspaceDir);
  }

  return { workspaceDir, created, preserved, missingTemplates };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

