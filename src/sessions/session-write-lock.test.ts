import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireSessionWriteLock } from "./session-write-lock.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-lock-test-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function tmp(name: string): string {
  return path.join(tmpRoot, name);
}

test("acquireSessionWriteLock: acquires + releases cleanly", async () => {
  const sessionFile = tmp("a.jsonl");
  const lock = await acquireSessionWriteLock({ sessionFile });
  // Lockfile should exist while held.
  await assert.doesNotReject(fs.stat(`${sessionFile}.lock`));
  await lock.release();
  // Released — file removed.
  await assert.rejects(fs.stat(`${sessionFile}.lock`));
});

test("acquireSessionWriteLock: contention surfaces as timeout", async () => {
  const sessionFile = tmp("b.jsonl");
  const first = await acquireSessionWriteLock({ sessionFile });
  // Second acquisition with a tight timeout should give up rather than block.
  await assert.rejects(
    () => acquireSessionWriteLock({ sessionFile, timeoutMs: 200 }),
    /Timed out waiting for session write lock/,
  );
  await first.release();
});

test("acquireSessionWriteLock: aborted signal short-circuits the wait", async () => {
  const sessionFile = tmp("c.jsonl");
  const holder = await acquireSessionWriteLock({ sessionFile });

  const ac = new AbortController();
  const acquirePromise = acquireSessionWriteLock({
    sessionFile,
    signal: ac.signal,
    timeoutMs: 60_000,
  });
  // Fire the abort after a tick — we want the wait loop to be running when
  // the signal trips.
  setTimeout(() => ac.abort(new Error("user cancelled")), 50);
  await assert.rejects(acquirePromise);
  await holder.release();
});

test("acquireSessionWriteLock: steals a lock whose holder PID is dead", async () => {
  const sessionFile = tmp("d.jsonl");
  const lockPath = `${sessionFile}.lock`;
  // Plant a lock file whose pid is implausible (PIDs in the millions are
  // unlikely to be alive on a test box, and process.kill(pid, 0) will
  // throw ESRCH).
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999_999, acquiredAt: Date.now() }),
    "utf8",
  );
  const lock = await acquireSessionWriteLock({ sessionFile, timeoutMs: 5_000 });
  // We should now hold the lock.
  const contents = await fs.readFile(lockPath, "utf8");
  const parsed = JSON.parse(contents) as { pid: number };
  assert.equal(parsed.pid, process.pid);
  await lock.release();
});
