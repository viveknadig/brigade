/**
 * Brigade virtual-office layer — Stage B sub-agent anchor.
 *
 * The full `## Org` block (see `render-org-block.ts`) is operator-
 * facing. Sub-agents inherit their spawner's department + a parent-
 * report edge for the spawn's lifetime (derivation Rule vii), but
 * they get a SHORTER context line that fits the minimal-mode prompt
 * shape (banner + universal sections only — no operator directory).
 *
 * `renderSubAgentAnchor(graph, parentAgentId)` returns:
 *   - `undefined` when `graph` is undefined (legacy mode → no anchor).
 *   - `undefined` when the parent isn't a known graph member (defensive).
 *   - A single one-line string otherwise, formatted as:
 *
 *       Spawned by <parent>, inheriting <department>.
 *
 * The line is fed into the assembler's existing `ephemeralSuffix`
 * slot (below the cache boundary) so a sub-agent's prompt cache key
 * isn't affected by inherited org membership — the cached prefix
 * stays identical to the legacy sub-agent prompt.
 *
 * STAGE-B CONTRACT
 *  - Stage A pinned Rule vii's edge shape; this Stage-B helper only
 *    REFLECTS the spawner's existing record back at the model. It does
 *    NOT mutate the graph and does NOT append a sub-agent member to
 *    `graph.members`. Stage C+ may add that lifecycle wire-up.
 */

import type { OrgGraph } from "../../agents/org/types.js";

export function renderSubAgentAnchor(
  graph: OrgGraph | undefined,
  parentAgentId: string,
): string | undefined {
  if (!graph) return undefined;
  const parent = graph.members[parentAgentId];
  if (!parent) return undefined;
  return `Spawned by ${parentAgentId}, inheriting ${parent.department}.`;
}
