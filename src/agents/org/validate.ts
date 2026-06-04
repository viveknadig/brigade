/**
 * Brigade virtual-office layer — config validation (Stage A).
 *
 * Hard violations throw `BrigadeOrgConfigError` with a stable code so
 * the CLI / TUI can render an actionable message. Soft warnings live
 * in `lints.ts`. The split mirrors the reference codebase's
 * config-validator pattern.
 *
 * Checks performed at Stage A:
 *
 *   1. `cfg.org.topOrder` resolves to a real member (or to the
 *      single-agent auto-derive fallback when no `cfg.agents.<id>.org`
 *      block is present).
 *   2. The top-of-org agent has `reportsTo === null`.
 *   3. Every member's `reportsTo` resolves to a real member.
 *   4. The `reportsTo` chain is acyclic.
 *   5. `cfg.org.departmentHeads[<dept>]` is a real member AND a member
 *      of the named department.
 *   6. `cfg.org.a2a.mode` is one of `derived | explicit | open`.
 *
 * Soft check emitted as a lint (NOT thrown):
 *
 *   - Manager chain deeper than 5 (Rule: depth-5 warning).
 *
 * Stage-A consumers (tests + audit-log only) call this synchronously.
 */

import type { BrigadeConfig } from "../../config/io.js";
import { BrigadeOrgConfigError } from "./types.js";

const MAX_DEPTH_WARN = 5;

export interface ValidationOutcome {
  /** Manager chain longer than `MAX_DEPTH_WARN`. Surfaced as a lint
   *  (NOT thrown). Stage-A audit-log records the count. */
  depthOverFive: boolean;
  /** Resolved topOrder id (after applying defaults). */
  topOrder: string;
}

export function validateOrgConfig(cfg: BrigadeConfig): ValidationOutcome {
  if (!cfg.org) {
    // Should never be called without cfg.org — bail-out is defensive.
    return { depthOverFive: false, topOrder: "" };
  }

  const mode = cfg.org.a2a?.mode;
  if (mode !== "derived" && mode !== "explicit" && mode !== "open") {
    throw new BrigadeOrgConfigError(
      "ORG_INVALID_A2A_MODE",
      `cfg.org.a2a.mode must be one of "derived" | "explicit" | "open" (got ${JSON.stringify(mode)})`,
      { received: mode },
    );
  }

  const topOrder = resolveTopOrder(cfg);

  const memberIds = collectMemberIds(cfg);

  // If no members are declared but cfg.org is present, that's a
  // single-agent auto-derive scenario — the derivation path produces
  // a synthesized member without consulting cfg.agents. Skip the
  // member-level checks in that case.
  if (memberIds.size === 0) {
    return { depthOverFive: false, topOrder };
  }

  if (!memberIds.has(topOrder)) {
    throw new BrigadeOrgConfigError(
      "ORG_TOPORDER_NOT_MEMBER",
      `cfg.org.topOrder=${JSON.stringify(topOrder)} does not match any agent in cfg.agents with an .org block`,
      { topOrder, knownMembers: [...memberIds].sort() },
    );
  }

  // Check #2: top-of-org agent must have reportsTo === null.
  const topMemberOrg = (cfg.agents?.[topOrder] as { org?: { reportsTo?: string | null; department?: string } } | undefined)?.org;
  if (topMemberOrg && topMemberOrg.reportsTo !== null) {
    throw new BrigadeOrgConfigError(
      "ORG_TOPORDER_REPORTSTO_NOT_NULL",
      `topOrder agent ${JSON.stringify(topOrder)} must have org.reportsTo === null (got ${JSON.stringify(topMemberOrg.reportsTo)})`,
      { topOrder, reportsTo: topMemberOrg.reportsTo },
    );
  }

  // Check #3 + #4: reportsTo references + acyclic chain.
  for (const id of memberIds) {
    const m = (cfg.agents?.[id] as { org?: { reportsTo?: string | null } } | undefined)?.org;
    if (!m) continue;
    const rt = m.reportsTo;
    if (rt === null || rt === undefined) continue;
    if (!memberIds.has(rt)) {
      throw new BrigadeOrgConfigError(
        "ORG_REPORTS_TO_UNKNOWN",
        `agent ${JSON.stringify(id)} reportsTo ${JSON.stringify(rt)} which is not a member`,
        { id, reportsTo: rt, knownMembers: [...memberIds].sort() },
      );
    }
  }

  // Acyclic check: depth-first walk from each member; track visited
  // on the current path. Any revisit is a cycle.
  let depthOverFive = false;
  for (const id of memberIds) {
    const { cycle, offending, depth } = walkChain(cfg, id, memberIds);
    if (cycle) {
      throw new BrigadeOrgConfigError(
        "ORG_CYCLE_DETECTED",
        `manager chain for agent ${JSON.stringify(id)} contains a cycle at ${JSON.stringify(offending)}`,
        { id, offending },
      );
    }
    if (depth > MAX_DEPTH_WARN) depthOverFive = true;
  }

  // Check #5: departmentHeads.
  const heads = cfg.org.departmentHeads ?? {};
  for (const [dept, headId] of Object.entries(heads)) {
    if (!memberIds.has(headId)) {
      throw new BrigadeOrgConfigError(
        "ORG_DEPARTMENT_HEAD_UNKNOWN",
        `departmentHeads[${JSON.stringify(dept)}]=${JSON.stringify(headId)} is not a member`,
        { dept, headId },
      );
    }
    const headMember = (cfg.agents?.[headId] as { org?: { department?: string } } | undefined)?.org;
    if (headMember && headMember.department !== dept) {
      throw new BrigadeOrgConfigError(
        "ORG_DEPARTMENT_HEAD_NOT_IN_DEPT",
        `departmentHeads[${JSON.stringify(dept)}]=${JSON.stringify(headId)} but that agent's org.department is ${JSON.stringify(headMember.department)}`,
        { dept, headId, actual: headMember.department },
      );
    }
  }

  return { depthOverFive, topOrder };
}

function resolveTopOrder(cfg: BrigadeConfig): string {
  const fromCfg = cfg.org?.topOrder?.trim();
  if (fromCfg && fromCfg.length > 0) return fromCfg;
  const fromDefaults = cfg.defaults?.agentId?.trim();
  if (fromDefaults && fromDefaults.length > 0) return fromDefaults;
  return "main";
}

function collectMemberIds(cfg: BrigadeConfig): Set<string> {
  const out = new Set<string>();
  const agents = cfg.agents ?? {};
  for (const [id, value] of Object.entries(agents)) {
    if (id === "defaults") continue;
    if (!value || typeof value !== "object") continue;
    const orgMeta = (value as { org?: { department?: string } }).org;
    if (orgMeta && typeof orgMeta.department === "string") out.add(id);
  }
  return out;
}

function walkChain(
  cfg: BrigadeConfig,
  start: string,
  memberIds: Set<string>,
): { cycle: boolean; offending: string | null; depth: number } {
  let cur: string | null = start;
  const seen = new Set<string>();
  let depth = 0;
  while (cur) {
    if (seen.has(cur)) return { cycle: true, offending: cur, depth };
    seen.add(cur);
    const orgMeta: { reportsTo?: string | null } | undefined = (
      cfg.agents?.[cur] as { org?: { reportsTo?: string | null } } | undefined
    )?.org;
    if (!orgMeta) break;
    const next: string | null | undefined = orgMeta.reportsTo;
    if (next === null || next === undefined) break;
    if (!memberIds.has(next)) break;
    cur = next;
    depth += 1;
  }
  return { cycle: false, offending: null, depth };
}
