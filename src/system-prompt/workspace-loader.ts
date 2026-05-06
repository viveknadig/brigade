import fs from "node:fs/promises";
import path from "node:path";

import type { ContextFile } from "./types.js";
import { sanitizeForPromptLiteral } from "./sanitize.js";

// Persona files brigade expects to find in <agentDir>/workspace/. Order
// matters — it determines the sequence inside the assembled prompt's
// `# Project Context` section. HEARTBEAT.md is intentionally absent: it
// belongs in the *dynamic suffix* (below the cache boundary) and is loaded
// via loadHeartbeatFile.
const STABLE_FILE_ORDER = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

// Per-file safety cap. Anything larger gets truncated by the budget pass
// (head + tail kept). 2 MB matches the upstream cap; legitimate persona
// files run a few hundred lines, so this only fires on accidents.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function loadWorkspaceContextFiles(workspaceDir: string): Promise<ContextFile[]> {
  const out: ContextFile[] = [];
  for (const name of STABLE_FILE_ORDER) {
    const filePath = path.join(workspaceDir, name);
    const content = await readContextFile(filePath);
    if (content === undefined) continue;
    // Preserve original case in the diagnostic name so a reader debugging
    // budget output sees `BOOTSTRAP.md`, matching what's on disk. The
    // assembler uppercases for headings; this is the source of truth.
    out.push({ name, path: filePath, content });
  }
  return out;
}

export async function loadHeartbeatFile(
  workspaceDir: string,
): Promise<ContextFile | undefined> {
  const filePath = path.join(workspaceDir, "HEARTBEAT.md");
  const content = await readContextFile(filePath);
  if (content === undefined) return undefined;
  return { name: "HEARTBEAT.md", path: filePath, content };
}

async function readContextFile(filePath: string): Promise<string | undefined> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size > MAX_FILE_BYTES) {
    // File too large — read first slice only so we still surface the
    // header guidance and the budget pass can truncate further. Slice the
    // buffer to bytes-actually-read so the converted string isn't padded
    // with zero bytes (which sanitize would strip but which waste cycles
    // and pollute diagnostics).
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, MAX_FILE_BYTES, 0);
      return sanitizeForPromptLiteral(buf.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  }
  return sanitizeForPromptLiteral(await fs.readFile(filePath, "utf8"));
}
