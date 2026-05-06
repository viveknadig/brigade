import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repairSessionFileIfNeeded } from "./session-file-repair.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-repair-test-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpRoot, name);
  await fs.writeFile(p, content, "utf8");
  return p;
}

test("repairSessionFileIfNeeded: missing file returns no-op", async () => {
  const r = await repairSessionFileIfNeeded({ sessionFile: "" });
  assert.equal(r.repaired, false);
  assert.match(r.reason!, /missing/);
});

test("repairSessionFileIfNeeded: nonexistent file returns no-op", async () => {
  const p = path.join(tmpRoot, "does-not-exist.jsonl");
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(r.repaired, false);
});

test("repairSessionFileIfNeeded: clean file is unchanged", async () => {
  const p = await writeFile(
    "clean.jsonl",
    `${JSON.stringify({ type: "session", id: "sess-1" })}\n` +
      `${JSON.stringify({ type: "user", text: "hi" })}\n`,
  );
  const before = await fs.readFile(p, "utf8");
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  const after = await fs.readFile(p, "utf8");
  assert.equal(r.repaired, false);
  assert.equal(r.droppedLines, 0);
  assert.equal(before, after);
});

test("repairSessionFileIfNeeded: drops trailing partial line", async () => {
  const p = await writeFile(
    "trailing.jsonl",
    `${JSON.stringify({ type: "session", id: "sess-1" })}\n` +
      `${JSON.stringify({ type: "user", text: "hi" })}\n` +
      `{"type":"assistant","tex`,
  );
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(r.repaired, true);
  assert.equal(r.droppedLines, 1);
  assert.ok(r.backupPath);
  const cleaned = await fs.readFile(p, "utf8");
  assert.equal(cleaned.split("\n").filter((l) => l.length > 0).length, 2);
});

test("repairSessionFileIfNeeded: handles CRLF line endings", async () => {
  const p = await writeFile(
    "crlf.jsonl",
    `${JSON.stringify({ type: "session", id: "sess-1" })}\r\n` +
      `${JSON.stringify({ type: "user", text: "hi" })}\r\n`,
  );
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  // Already valid → no repair.
  assert.equal(r.repaired, false);
});

test("repairSessionFileIfNeeded: refuses to rewrite if first line is not a session header", async () => {
  const p = await writeFile(
    "not-a-session.jsonl",
    `${JSON.stringify({ type: "user", text: "no header" })}\n{garbage`,
  );
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(r.repaired, false);
  assert.match(r.reason!, /not a session header/);
});

test("repairSessionFileIfNeeded: empty file is a no-op", async () => {
  const p = await writeFile("empty.jsonl", "");
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(r.repaired, false);
});

test("repairSessionFileIfNeeded: idempotent — second call is no-op after first repair", async () => {
  const p = await writeFile(
    "idempotent.jsonl",
    `${JSON.stringify({ type: "session", id: "sess-1" })}\n` +
      `not-json-line\n` +
      `${JSON.stringify({ type: "user", text: "hi" })}\n`,
  );
  const first = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(first.repaired, true);
  assert.equal(first.droppedLines, 1);
  const second = await repairSessionFileIfNeeded({ sessionFile: p });
  assert.equal(second.repaired, false);
  assert.equal(second.droppedLines, 0);
});

test("repairSessionFileIfNeeded: BOM at start does not break parsing of header", async () => {
  const p = await writeFile(
    "bom.jsonl",
    `﻿${JSON.stringify({ type: "session", id: "sess-1" })}\n` +
      `${JSON.stringify({ type: "user", text: "hi" })}\n`,
  );
  const r = await repairSessionFileIfNeeded({ sessionFile: p });
  // Clean (we strip the BOM before parsing).
  assert.equal(r.repaired, false);
});
