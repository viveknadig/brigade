/**
 * Brigade virtual-office layer — single-line org anchor.
 *
 * `renderOrgBlock(graph, callerAgentId, opts)` produces ONE line of
 * prompt text that gets injected into the assembled system prompt
 * when `cfg.org` is present (i.e. when `deriveOrgGraph(cfg)` returns a
 * defined graph).
 *
 * ANCHOR CONTRACT
 * ---------------
 *   - When `graph === undefined`, this helper returns `undefined`. The
 *     assembler treats that as "do not emit a block" — so a vanilla
 *     install (no `cfg.org`) gets ZERO new bytes in the assembled prompt.
 *     This is the load-bearing invariant for the additive-conditional
 *     constraint: existing behaviour is preserved bit-for-bit.
 *   - When `graph` is defined but `callerAgentId` isn't a known member
 *     of the graph (e.g. an ad-hoc agent that wasn't given a
 *     `cfg.agents.<id>.org` block in a multi-agent install), we again
 *     return `undefined` rather than emitting a half-rendered block.
 *     The model gets the legacy "no org context" shape for that turn.
 *   - The render is EXACTLY ONE line — no embedded newlines. The model
 *     gets a terse pointer to the new consolidated `org` tool for the
 *     full peer / reachability picture; the prompt itself stays lean.
 *
 * NO external agent-codebase IDENTIFIERS.
 * All literal text in this module is fully Brigade-native.
 */

import type { OrgGraph } from "../../agents/org/types.js";

export interface RenderOrgBlockOpts {
  /** Reserved for forward-compat. Currently unused — the single-line
   *  anchor has no toggles. Kept on the signature so callers passing
   *  `opts` continue to compile across the consolidation. */
  readonly compact?: boolean;
}

/**
 * Render the per-agent single-line org anchor. Returns `undefined`
 * when no anchor should be emitted (legacy mode OR caller agent not in
 * the org). The string return shape is the EXACT line content — no
 * trailing newline; the assembler appends its own blank-line padding.
 */
export function renderOrgBlock(
  graph: OrgGraph | undefined,
  callerAgentId: string,
  _opts: RenderOrgBlockOpts = {},
): string | undefined {
  if (!graph) return undefined;
  const caller = graph.members[callerAgentId];
  if (!caller) return undefined;
  void _opts;

  const role =
    caller.role && caller.role.trim().length > 0 ? caller.role.trim() : null;

  // Top-of-org gets a distinct anchor (no "reports to X" clause).
  if (callerAgentId === graph.topOrder) {
    const head = role
      ? `Org: you are ${callerAgentId}, ${role}, top-of-org.`
      : `Org: you are ${callerAgentId}, top-of-org.`;
    return `${head} Call org({action:"describe"}) for direct reports + departments.`;
  }

  // Non-top callers: phrase as "you are <id>, <role> in <department>, reports to <Y>".
  const dept = caller.department;
  const manager = caller.reportsTo ?? graph.topOrder;
  const head = role
    ? `Org: you are ${callerAgentId}, ${role} in ${dept}, reports to ${manager}.`
    : `Org: you are ${callerAgentId} in ${dept}, reports to ${manager}.`;
  return `${head} Call org({action:"describe"}) for peers + reachability.`;
}
