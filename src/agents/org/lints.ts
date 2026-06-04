/**
 * Brigade virtual-office layer — soft warnings (Stage A).
 *
 * Pure functions. Stage-A consumers (audit-log + future CLI `org
 * doctor` command) call these AFTER `validateOrgConfig` succeeds.
 * A lint is informative — never a hard rejection.
 *
 * Warning families:
 *
 *   - single-member-dept            → encourage dept consolidation or
 *                                     promotion of the lone agent.
 *   - extraAllow/extraDeny dangling → operator typo: `from` or `to`
 *                                     isn't a real member.
 *   - extraAllow no-op              → the edge was already derived,
 *                                     so the override changes nothing.
 *   - depth-5 warning               → manager chain too deep.
 */

import type { BrigadeConfig } from "../../config/io.js";
import type { OrgGraph, OrgLintWarning } from "./types.js";

export function lintOrgGraph(cfg: BrigadeConfig, graph: OrgGraph): OrgLintWarning[] {
  const out: OrgLintWarning[] = [];

  // (a) single-member department — only when the member came from the
  // explicit `cfg.agents.<id>.org` block. Auto-derived solo graphs are
  // expected to have a single member and shouldn't generate noise.
  for (const [dept, ids] of Object.entries(graph.departments)) {
    if (ids.length !== 1) continue;
    const onlyId = ids[0];
    if (!onlyId) continue;
    const m = graph.members[onlyId];
    if (m?.source !== "explicit") continue;
    out.push({
      code: "ORG_SINGLE_MEMBER_DEPARTMENT",
      message: `Department ${JSON.stringify(dept)} has only one member (${JSON.stringify(onlyId)}). Consider folding it into a sibling dept or promoting the role.`,
      detail: { department: dept, member: onlyId },
    });
  }

  const memberIds = new Set(Object.keys(graph.members));
  const org = cfg.org;
  if (org) {
    // (b) extraAllow / extraDeny dangling references
    for (const a of org.a2a?.extraAllow ?? []) {
      if (a?.from && !memberIds.has(a.from)) {
        out.push({
          code: "ORG_EXTRA_ALLOW_DANGLING_FROM",
          message: `cfg.org.a2a.extraAllow entry has unknown from=${JSON.stringify(a.from)}`,
          detail: { entry: a },
        });
      }
      if (a?.to && !memberIds.has(a.to)) {
        out.push({
          code: "ORG_EXTRA_ALLOW_DANGLING_TO",
          message: `cfg.org.a2a.extraAllow entry has unknown to=${JSON.stringify(a.to)}`,
          detail: { entry: a },
        });
      }
    }
    for (const d of org.a2a?.extraDeny ?? []) {
      if (d?.from && !memberIds.has(d.from)) {
        out.push({
          code: "ORG_EXTRA_DENY_DANGLING_FROM",
          message: `cfg.org.a2a.extraDeny entry has unknown from=${JSON.stringify(d.from)}`,
          detail: { entry: d },
        });
      }
      if (d?.to && !memberIds.has(d.to)) {
        out.push({
          code: "ORG_EXTRA_DENY_DANGLING_TO",
          message: `cfg.org.a2a.extraDeny entry has unknown to=${JSON.stringify(d.to)}`,
          detail: { entry: d },
        });
      }
    }

    // (c) extraAllow no-op: pair would already exist by derivation rule.
    // We approximate "already derived" by checking that NO derived
    // edge in `graph.edges` other than the extra-allow itself matches
    // the (from, to) pair. Since `derive-graph.applyExtras` only adds
    // an `extra-allow` edge when the pair was absent, we instead
    // recompute the pre-extras pair set.
    const derivedPairs = new Set<string>();
    for (const e of graph.edges) {
      if (e.reason === "extra-allow") continue;
      derivedPairs.add(`${e.from}|${e.to}`);
    }
    for (const a of org.a2a?.extraAllow ?? []) {
      if (!a?.from || !a?.to) continue;
      if (derivedPairs.has(`${a.from}|${a.to}`)) {
        out.push({
          code: "ORG_EXTRA_ALLOW_NO_OP",
          message: `cfg.org.a2a.extraAllow entry ${JSON.stringify(a.from)}→${JSON.stringify(a.to)} is already derived; the override has no effect`,
          detail: { entry: a },
        });
      }
    }
  }

  // (d) depth-5 warning. Recomputed here so this module can be called
  // independently of `validateOrgConfig`'s return value.
  if (deepestChainDepth(graph) > 5) {
    out.push({
      code: "ORG_DEPTH_OVER_FIVE",
      message: `Manager chain exceeds depth 5; flat orgs route faster.`,
      detail: { depth: deepestChainDepth(graph) },
    });
  }

  return out;
}

function deepestChainDepth(graph: OrgGraph): number {
  let max = 0;
  for (const id of Object.keys(graph.members)) {
    let cur: string | null = id;
    const seen = new Set<string>();
    let d = 0;
    while (cur) {
      if (seen.has(cur)) break; // defensive — cycles are rejected upstream
      seen.add(cur);
      const member: OrgGraph["members"][string] | undefined = graph.members[cur];
      if (!member) break;
      const next: string | null = member.reportsTo ?? null;
      if (!next) break;
      cur = next;
      d += 1;
    }
    if (d > max) max = d;
  }
  return max;
}
