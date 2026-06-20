/**
 * Brigade virtual-office layer — type surface (Stage A).
 *
 * STAGE-A CONTRACT: Inert data only. Nothing in the existing runtime
 * reads any of these types yet. The derivation helper exists, the
 * config field exists, but every consumer falls back to legacy
 * behaviour when `cfg.org` is absent. Stages B/C/D wire the
 * consumers.
 *
 * The wider design doc lives in the user's plan brief; the locked
 * contract is:
 *
 *   - `cfg.org` is OPTIONAL on `BrigadeConfig`. Absent → legacy mode.
 *   - `cfg.agents.<id>.org` is OPTIONAL on `AgentConfig`. Absent on a
 *     member means the member is auto-derived (single-agent install)
 *     OR rejected (multi-agent install with `cfg.org` present).
 *   - `deriveOrgGraph(cfg)` returns `OrgGraph | undefined`. Undefined
 *     signals "legacy mode" to every consumer.
 *
 * No external agent-codebase identifiers are
 * referenced from this file.
 */

import type { BrigadeOrgConfig } from "../../config/io.js";

// Re-export the top-level config shape from the config layer so callers
// can import everything org-related from one module. This is a TYPE-ONLY
// re-export — no runtime value crosses the layer boundary.
export type { BrigadeOrgConfig };

/**
 * The seven derivation rules (see plan brief). Each edge in the graph
 * carries the rule that produced it, so lints + UI rendering can
 * explain WHY two agents may talk. Reasons are stable strings and
 * intended for log diff + audit JSONL.
 */
export type OrgEdgeReason =
  /** Rule (i): agent → manager (escalation upward). */
  | "escalation-up"
  /** Rule (ii): manager → direct report (assignment downward). */
  | "assignment-down"
  /** Rule (iii): same-department peers (lateral). */
  | "lateral-peer"
  /** Rule (iv): broadcast edge to/from the top-of-org agent. */
  | "topOrder-broadcast"
  /** Rule (vi): operator-authored extraAllow override. */
  | "extra-allow"
  /** Rule (vii): sub-agent inherits spawner's department + parent. */
  | "subagent-inherited"
  /** Mode === "open" all-to-all (test/diagnostic mode). */
  | "open-mode";

/**
 * One directed edge in the derived org graph. Edges are directional —
 * `from` is the sender, `to` is the receiver. A bidirectional channel
 * (Rules iii + iv) appears as two records, one per direction, so
 * Stage-C consumers can refuse a single direction without inverting
 * the matrix.
 */
export interface EdgeRecord {
  from: string;
  to: string;
  reason: OrgEdgeReason;
  /** Optional human-readable note (e.g. operator's `extraAllow.reason`). */
  note?: string;
}

/**
 * The derived org graph — the in-memory product of `deriveOrgGraph`.
 *
 * `members` is the canonical roster (every agent that participates in
 * the org). `edges` is the directed allow matrix produced by the seven
 * rules. `departments` is the inverse index of department → member-id
 * list, computed once so consumers don't repeatedly scan `members`.
 * `topOrder` echoes back the resolved top-of-org id so consumers don't
 * need to re-read cfg.
 *
 * Stage-A guarantee: NO existing runtime reads this. Only the Stage-A
 * tests touch it.
 */
export interface OrgGraph {
  topOrder: string;
  members: Record<
    string,
    {
      department: string;
      reportsTo: string | null;
      role?: string;
      bio?: string;
      /** Provenance: did the member come from `cfg.agents.<id>.org`
       *  ("explicit") or from `auto-derive.ts` ("auto")? Stage-A lints
       *  use this to suppress single-member-dept warnings for the
       *  auto-derived solo case. */
      source: "explicit" | "auto";
    }
  >;
  /** Inverse index: department slug → member ids in that department. */
  departments: Record<string, string[]>;
  /** All directed (from, to) edges in the allow matrix. */
  edges: EdgeRecord[];
  /** Echoed mode so consumers can short-circuit (`explicit` → legacy). */
  mode: "derived" | "explicit" | "open";
}

/**
 * Hard-violation error thrown by `agents/org/validate.ts` and
 * `agents/org/derive-graph.ts` when the operator's org config breaks
 * an invariant (cycle, dangling reportsTo, topOrder.reportsTo !== null,
 * departmentHeads referencing non-member, etc.).
 *
 * The class is a plain `Error` subclass so existing try/catch chains
 * downstream don't need to learn a new shape. The `code` field carries
 * the machine-readable diagnostic for tests + CLI rendering.
 */
export class BrigadeOrgConfigError extends Error {
  readonly code: BrigadeOrgConfigErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: BrigadeOrgConfigErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrigadeOrgConfigError";
    this.code = code;
    this.detail = detail;
  }
}

/** Stable machine-readable codes for `BrigadeOrgConfigError.code`. */
export type BrigadeOrgConfigErrorCode =
  | "ORG_CYCLE_DETECTED"
  | "ORG_TOPORDER_REPORTSTO_NOT_NULL"
  | "ORG_TOPORDER_NOT_MEMBER"
  | "ORG_REPORTS_TO_UNKNOWN"
  | "ORG_DEPARTMENT_HEAD_UNKNOWN"
  | "ORG_DEPARTMENT_HEAD_NOT_IN_DEPT"
  | "ORG_MEMBER_MISSING_DEPARTMENT"
  | "ORG_INVALID_A2A_MODE";

/**
 * Soft warning produced by `agents/org/lints.ts`. Lints never reject
 * a config — they surface improvable shapes (single-member depts,
 * dangling `extraAllow.from`, no-op `extraAllow` overrides, depth > 5).
 */
export interface OrgLintWarning {
  code: OrgLintCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** Stable codes for soft warnings (see `lints.ts`). */
export type OrgLintCode =
  | "ORG_SINGLE_MEMBER_DEPARTMENT"
  | "ORG_EXTRA_ALLOW_DANGLING_FROM"
  | "ORG_EXTRA_ALLOW_DANGLING_TO"
  | "ORG_EXTRA_DENY_DANGLING_FROM"
  | "ORG_EXTRA_DENY_DANGLING_TO"
  | "ORG_EXTRA_ALLOW_NO_OP"
  | "ORG_DEPTH_OVER_FIVE";

/**
 * Audit-log entry appended by `agents/org/audit-log.ts` whenever
 * `deriveOrgGraph` runs against a non-empty `cfg.org`. The 30-day GC
 * is reserved for later; Stage-A only appends.
 */
export interface OrgDeriveAuditEntry {
  ts: string;
  topOrder: string;
  mode: OrgGraph["mode"];
  edgeCount: number;
  memberCount: number;
  extraCounts: { allow: number; deny: number };
  warnings: number;
}
