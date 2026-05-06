import fs from "node:fs/promises";

// Shared filesystem helpers for the workspace subsystem. Hoisted so
// `bootstrap.ts` and `state.ts` aren't each shipping a private copy of
// the same file-existence probe.

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
