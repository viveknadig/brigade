import fs from "node:fs/promises";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

// Per-session marker that the bootstrap context (workspace persona files +
// any first-turn guidance) has been delivered into the model's context.
//
// Why this exists in addition to the workspace-level lifecycle marker:
//
//   workspace-state.json (`bootstrapSeededAt` / `setupCompletedAt`)
//     Tracks the workspace's first-run lifecycle: did onboard write
//     BOOTSTRAP.md, and has the user/agent consumed it. Workspace-scoped.
//
//   <session>.jsonl custom event (this file)
//     Tracks per-session "have we delivered the full bootstrap context
//     to *this* session yet?" Session-scoped. Lets sub-agents and
//     post-compaction sessions correctly re-emit the first-turn nudge
//     when they need it, even though the workspace has long since
//     completed setup.
//
// The reference codebase carries the same two-layer pattern. Brigade
// adopts it so future sub-agent and compaction layers don't have to
// re-plumb through the agent kernel.

export const BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE =
  "brigade:bootstrap-context:delivered";

// Bound the tail scan so a long-running session's JSONL doesn't force a
// multi-megabyte read on every turn. 256 KiB / 500 records is more than
// enough to cover the most-recent bootstrap delivery + any compaction
// events that would invalidate it.
const TAIL_SCAN_MAX_BYTES = 256 * 1024;
const TAIL_SCAN_MAX_RECORDS = 500;

// Returns true when the bootstrap context has already been delivered to
// this session and a compaction has not occurred since. A compaction
// after the delivery is treated as invalidation because the bootstrap
// content has likely been compacted out of the model's working context;
// the next turn should re-deliver.
export async function hasDeliveredBootstrapToSession(
  transcriptPath: string,
): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.lstat(transcriptPath);
  } catch {
    return false;
  }
  // Refuse to follow symlinks — defending against a workspace-write
  // path that points outside the agent dir.
  if (stat.isSymbolicLink()) return false;
  if (!stat.isFile() || stat.size === 0) return false;

  const handle = await fs.open(transcriptPath, "r");
  try {
    const bytesToRead = Math.min(stat.size, TAIL_SCAN_MAX_BYTES);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const offset = stat.size - bytesToRead;
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    let text = buffer.toString("utf8", 0, bytesRead);

    // If we sliced into the middle of a line, drop the partial leading line.
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return false;
      text = text.slice(firstNewline + 1);
    }

    const records = text
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .slice(-TAIL_SCAN_MAX_RECORDS);

    // Walk backwards: a `compaction` record encountered before we find
    // the marker means the marker (if any) has been compacted away —
    // treat as not-delivered. Finding the marker first means delivered
    // and still valid.
    let compactionAfterDelivery = false;
    for (let i = records.length - 1; i >= 0; i--) {
      const line = records[i];
      if (!line) continue;
      let entry: { type?: string; customType?: string } | null;
      try {
        entry = JSON.parse(line) as { type?: string; customType?: string };
      } catch {
        continue;
      }
      if (entry?.type === "compaction") {
        compactionAfterDelivery = true;
        continue;
      }
      if (
        entry?.type === "custom" &&
        entry.customType === BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE
      ) {
        return !compactionAfterDelivery;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

// Emit the marker into the session JSONL via Pi's SessionManager. Called
// after a successful turn that delivered the full bootstrap context, so
// the next turn (or sub-agent fork) can short-circuit re-injection.
//
// Pi's `appendCustomEntry(customType, data)` writes a `{type:"custom",
// customType, data, ...}` record to the JSONL. Best-effort: any error is
// swallowed because the marker is observability, not correctness.
export function markBootstrapDeliveredToSession(
  sessionManager: SessionManager,
): void {
  try {
    const sm = sessionManager as unknown as {
      appendCustomEntry?: (customType: string, data: unknown) => void;
    };
    if (typeof sm.appendCustomEntry !== "function") return;
    sm.appendCustomEntry(BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE, {
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Marker is observability — never block a successful turn because
    // the marker write itself errored.
  }
}
