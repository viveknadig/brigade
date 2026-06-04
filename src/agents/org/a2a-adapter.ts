/**
 * Brigade virtual-office layer — A2A policy adapter (Stage C).
 *
 * `orgGraphAsA2APolicy(graph)` returns an `AgentToAgentPolicy`
 * implementation that uses the derived org `graph.canSend(from, to)`
 * reasoning instead of the legacy flat `allow` array.
 *
 * STAGE-C CONTRACT
 * ----------------
 *   - Only called when `cfg.org` is present AND `cfg.org.a2a.mode ===
 *     "derived"` (or `"open"`). When `cfg.org` is absent, the legacy
 *     `createAgentToAgentPolicy({enabled, allow})` from
 *     `tools/sessions/shared.ts` runs unchanged.
 *   - The returned object satisfies the SAME shape as the legacy
 *     policy: `enabled / matchesAllow / isAllowed`. We keep
 *     `enabled === true` and `matchesAllow` always-true so callers
 *     that have not been taught about the org layer (e.g. tests
 *     stubbing the shape) still behave as if A2A is enabled — the
 *     real reasoning happens in `isAllowed`, which is the only entry
 *     point existing call sites consult for actual cross-agent
 *     decisions.
 *   - Self-targets are always allowed (mirrors the legacy policy's
 *     `requesterAgentId === targetAgentId` short-circuit).
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw
 * identifiers are referenced from this file.
 */

import type { AgentToAgentPolicy } from "../tools/sessions/shared.js";
import type { EdgeRecord, OrgGraph } from "./types.js";

/**
 * Build an A2A policy from a derived org graph. The returned policy
 * defers every cross-agent decision to `graph.edges` — `isAllowed(from,
 * to)` returns true iff there exists a directed edge `from → to` in
 * the graph (regardless of the edge's `reason`).
 */
export function orgGraphAsA2APolicy(graph: OrgGraph): AgentToAgentPolicy {
  // Precompute a Set<`from|to`> once so every isAllowed call is O(1).
  // Edges are rebuilt by `deriveOrgGraph` on each cache miss, so the
  // set is in sync with the graph it was created from.
  const edgeSet = buildEdgeSet(graph.edges);

  const matchesAllow = (_agentId: string): boolean => {
    // Legacy policies use this to seed catalog-side reachability hints.
    // With the org graph there's no flat allowlist to consult; the only
    // meaningful answer is "membership matters in isAllowed", so we
    // return true here and let isAllowed reject. Anyone who explicitly
    // calls matchesAllow on an org-mode policy gets a permissive
    // answer — which is the safer default than a hard false that would
    // hide every peer from listing UIs.
    return true;
  };

  const isAllowed = (requesterAgentId: string, targetAgentId: string): boolean => {
    if (requesterAgentId === targetAgentId) return true;
    // If either side isn't an org member, fall back to the safer
    // answer: false. An ad-hoc agent without a `cfg.agents.<id>.org`
    // block in a multi-agent org install is intentionally outside the
    // routing fabric.
    if (!graph.members[requesterAgentId]) return false;
    if (!graph.members[targetAgentId]) return false;
    return edgeSet.has(`${requesterAgentId}|${targetAgentId}`);
  };

  return { enabled: true, matchesAllow, isAllowed };
}

/**
 * Build the `from|to` set used by `isAllowed`. Centralised so a future
 * Stage-D verb-aware policy (delegate/escalate/review) can swap in a
 * `Map<key, EdgeReason>` without touching the call sites.
 */
function buildEdgeSet(edges: EdgeRecord[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) out.add(`${e.from}|${e.to}`);
  return out;
}
