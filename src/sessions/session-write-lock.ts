// Cross-process advisory lock for session JSONL files.
//
// Two `brigade agent` invocations targeting the same session would otherwise
// race the JSONL append path. Pi's SessionManager doesn't lock; if process A
// writes a partial line and process B writes its own line in the middle, the
// transcript ends up with interleaved bytes that the next reader can't parse
// (and our session-file-repair would have to drop). Worse, both processes
// believe their writes succeeded.
//
// Strategy: PID-tagged lockfile next to the session JSONL. Acquire by
// `fs.open` with the `wx` flag (exclusive create). If creation fails because
// the file already exists, read the holder PID and decide:
//   • holder is alive → wait, retry with backoff
//   • holder is dead → steal the lock (rewrite with our PID)
//   • holder is older than STALE_LOCK_MS → steal regardless
//
// On release we unlink the lockfile. On crash, the lockfile gets stale-stolen
// by the next acquirer rather than blocking the user forever.
//
// Why not `proper-lockfile`/`fs-ext`/etc.: zero-dep is the rule for the
// runtime kernel. The file is small, the algorithm is fifteen lines, and
// the failure mode (waiting up to STALE_LOCK_MS for a stale lock to be
// stolen) is acceptable for a CLI agent service.

import fs from "node:fs/promises";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("sessions/lock");

// Lockfile age past which we steal regardless of whether the holder PID is
// pingable. Generous because a long-running compaction can hold the session
// for several minutes legitimately.
const STALE_LOCK_MS = 10 * 60_000; // 10 minutes
const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 1_000;

export interface SessionWriteLock {
  release: () => Promise<void>;
}

export interface AcquireSessionWriteLockArgs {
  sessionFile: string;
  // Caller-provided abort signal — wakes the waiter if the user Ctrl-Cs
  // while we're waiting for a busy lock.
  signal?: AbortSignal;
  // Cap on how long we'll wait before giving up. Default 30s; at the
  // threshold we throw rather than silently stealing, so the operator
  // sees a real error if a peer process is genuinely stuck.
  timeoutMs?: number;
}

interface LockfileContents {
  pid: number;
  hostname?: string;
  acquiredAt: number;
}

export async function acquireSessionWriteLock(
  args: AcquireSessionWriteLockArgs,
): Promise<SessionWriteLock> {
  const lockPath = `${args.sessionFile}.lock`;
  const dir = path.dirname(args.sessionFile);
  await fs.mkdir(dir, { recursive: true });

  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  let pollMs = POLL_INITIAL_MS;

  while (true) {
    if (args.signal?.aborted) {
      throw args.signal.reason ?? new Error("Lock acquisition aborted");
    }

    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        const payload: LockfileContents = {
          pid: process.pid,
          acquiredAt: Date.now(),
        };
        await handle.writeFile(JSON.stringify(payload), { encoding: "utf8" });
      } finally {
        await handle.close();
      }
      log.debug("session lock acquired", { lockPath, pid: process.pid });
      return { release: () => releaseLock(lockPath) };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") {
        throw err;
      }
    }

    // Lock held — inspect the holder.
    const stolen = await maybeStealStaleLock(lockPath);
    if (stolen) continue;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for session write lock (${lockPath}). ` +
          `Another brigade process is writing this session — wait for it to ` +
          `finish or remove the lockfile manually if the holder is dead.`,
      );
    }

    await waitWithSignal(pollMs, args.signal);
    pollMs = Math.min(POLL_MAX_MS, Math.floor(pollMs * 1.5));
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
    log.debug("session lock released", { lockPath });
  } catch (err) {
    // Lock vanished from under us — acceptable; release is best-effort.
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      log.warn("failed to release session lock", { lockPath, error: (err as Error).message });
    }
  }
}

async function maybeStealStaleLock(lockPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    // Disappeared between EEXIST and stat — race a retry.
    return true;
  }

  let payload: LockfileContents | null = null;
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    payload = JSON.parse(raw) as LockfileContents;
  } catch {
    payload = null;
  }

  const holderAlive = payload && payload.pid > 0 && isProcessAlive(payload.pid);
  const tooOld = Date.now() - stat.mtimeMs > STALE_LOCK_MS;

  if (!holderAlive || tooOld) {
    try {
      await fs.unlink(lockPath);
      log.warn("stole stale session lock", {
        lockPath,
        holderPid: payload?.pid,
        holderAlive,
        tooOld,
      });
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return true;
      log.warn("failed to steal stale lock", { lockPath, error: (err as Error).message });
    }
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 doesn't deliver a signal — it just reports whether the
    // process exists / we can address it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM") return true; // exists, just not ours to signal
    return false;
  }
}

async function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("Aborted"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
