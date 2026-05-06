// JSONL session-file repair.
//
// Pi's SessionManager throws on the first malformed JSONL line it encounters
// when opening a transcript. A power-loss mid-write, a SIGKILL during append,
// or a disk-full error can leave a partial line at the tail of the file —
// without this pass the very next `brigade agent` invocation would crash on
// startup with no obvious cause.
//
// Algorithm:
//
//   1. Read the file as UTF-8 (BOM-aware).
//   2. Split on /\r?\n/ to handle either line ending.
//   3. For each non-empty line, try `JSON.parse`. Drop lines that fail.
//   4. If nothing was dropped, return as a fast no-op (idempotent).
//   5. Validate the first surviving entry is a `{type:"session", id}` header
//      so we don't rewrite a totally-unrelated file (e.g. someone gave us a
//      misnamed log).
//   6. Write the original file to a `.bak-<pid>-<ts>` snapshot first so the
//      repair is reversible.
//   7. Write the cleaned content to a tmp file then rename it onto the
//      session path. Rename is atomic on POSIX; on Windows the rename
//      replaces the target file in one operation.
//
// Failure modes:
//   • Read fails (file vanished, permission denied) → return `{repaired:false}`
//     with a reason; do not throw. Caller proceeds; SessionManager will
//     produce its own error for an upstream caller.
//   • Write or rename fails partway through → original file is untouched
//     because we wrote to a tmp first. Best-effort cleanup of the tmp.
//   • Empty file → return `{repaired:false}` with reason; not our problem.

import fs from "node:fs/promises";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("sessions/repair");

export interface RepairReport {
  repaired: boolean;
  droppedLines: number;
  backupPath?: string;
  reason?: string;
}

export interface RepairArgs {
  sessionFile: string;
  // Optional override warn callback. Defaults to the subsystem logger.
  warn?: (message: string) => void;
}

const UTF8_BOM = "﻿";

export async function repairSessionFileIfNeeded(args: RepairArgs): Promise<RepairReport> {
  if (!args.sessionFile || args.sessionFile.trim() === "") {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(args.sessionFile);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      // No file is fine — Pi will create it on first append.
      return { repaired: false, droppedLines: 0, reason: "no session file" };
    }
    return {
      repaired: false,
      droppedLines: 0,
      reason: `failed to stat session file: ${(err as Error).message}`,
    };
  }
  if (!stat.isFile()) {
    return { repaired: false, droppedLines: 0, reason: "session path is not a regular file" };
  }
  if (stat.size === 0) {
    return { repaired: false, droppedLines: 0, reason: "empty session file" };
  }

  let content: string;
  try {
    content = await fs.readFile(args.sessionFile, "utf8");
  } catch (err) {
    return {
      repaired: false,
      droppedLines: 0,
      reason: `failed to read session file: ${(err as Error).message}`,
    };
  }

  if (content.startsWith(UTF8_BOM)) content = content.slice(1);

  const rawLines = content.split(/\r?\n/u);
  const entries: string[] = [];
  let droppedLines = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
      entries.push(line);
    } catch {
      droppedLines++;
    }
  }

  if (entries.length === 0) {
    return {
      repaired: false,
      droppedLines,
      reason: "session file contains no parseable lines",
    };
  }

  if (droppedLines === 0) {
    // Idempotent fast path — file is clean.
    return { repaired: false, droppedLines: 0 };
  }

  // Quick sanity check that the head looks like a session header. Without
  // this we'd happily rewrite an arbitrary file someone passed in by name.
  let headerOk = false;
  try {
    const head = JSON.parse(entries[0]!) as { type?: unknown; id?: unknown };
    headerOk =
      head &&
      typeof head === "object" &&
      head.type === "session" &&
      typeof head.id === "string";
  } catch {
    headerOk = false;
  }
  if (!headerOk) {
    return {
      repaired: false,
      droppedLines,
      reason: "first surviving line is not a session header — refusing to rewrite",
    };
  }

  const cleaned = `${entries.join("\n")}\n`;
  const ts = Date.now().toString(36);
  const backupPath = `${args.sessionFile}.bak-${process.pid}-${ts}`;
  const tmpPath = `${args.sessionFile}.repair-${process.pid}-${ts}.tmp`;
  const dir = path.dirname(args.sessionFile);

  try {
    await fs.writeFile(backupPath, content, "utf8");
    await fs.writeFile(tmpPath, cleaned, "utf8");
    await fs.rename(tmpPath, args.sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort orphan cleanup
    }
    return {
      repaired: false,
      droppedLines,
      backupPath,
      reason: `repair failed: ${(err as Error).message}`,
    };
  }

  const message = `session file repaired: dropped ${droppedLines} malformed line(s) (${path.basename(
    args.sessionFile,
  )})`;
  if (args.warn) {
    args.warn(message);
  } else {
    log.warn(message, { sessionFile: args.sessionFile, droppedLines, backupPath, dir });
  }

  return { repaired: true, droppedLines, backupPath };
}
