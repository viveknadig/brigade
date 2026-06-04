/**
 * Brigade virtual-office layer — append-only derivation audit log (Stage A).
 *
 * Writes one JSONL record per successful `deriveOrgGraph` call when
 * `cfg.org` is present. The 30-day GC is reserved for later; Stage-A
 * only appends.
 *
 * Path: `<stateDir>/workspace/logs/org-derive.jsonl`
 *
 * Notes:
 *
 *   - Writes are best-effort: filesystem failures are swallowed so a
 *     read-only workspace never crashes the derivation path.
 *   - The path lives under workspace/logs so backup + redact tooling
 *     that already scans that directory picks the file up for free.
 *   - Stage-A consumers: tests + future CLI `org doctor`. NO existing
 *     runtime calls this.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import type { OrgDeriveAuditEntry } from "./types.js";

export function appendOrgDeriveAudit(entry: OrgDeriveAuditEntry): void {
  try {
    const file = resolveOrgDeriveAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort: never let an audit-write failure abort the
    // derivation path. The audit log is observability, not a
    // contract.
  }
}

export function resolveOrgDeriveAuditPath(): string {
  return path.join(resolveStateDir(), "workspace", "logs", "org-derive.jsonl");
}
