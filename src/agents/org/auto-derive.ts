/**
 * Brigade virtual-office layer — single-agent auto-derive (Stage A).
 *
 * Locked design default #1: solo installs synthesize an org graph
 * IN-MEMORY ONLY. No file write happens until the operator runs
 * `brigade org init` (Stage D). This module is the single source of
 * the in-memory synthesis.
 *
 * Locked design default #2: the solo agent's role string is the
 * literal `"Chief of Staff"`. Department name defaults to
 * `"office"` so the lint-pass doesn't flag a single-member dept
 * for the auto-derived case (the lint reads `source === "auto"`
 * and skips).
 *
 * Returns `undefined` for multi-agent installs (the operator must
 * opt in by authoring `cfg.org`). Returns `undefined` when no agents
 * exist at all (empty config).
 */

import type { BrigadeConfig } from "../../config/io.js";
import type { OrgGraph } from "./types.js";

const SOLO_DEPARTMENT = "office";
const SOLO_ROLE = "Chief of Staff";

export function autoDeriveSoloGraph(cfg: BrigadeConfig): OrgGraph | undefined {
  // `cfg.org` MUST be absent — this is the legacy-mode auto-derive path.
  if (cfg.org) return undefined;

  const realAgents = collectRealAgents(cfg);
  if (realAgents.length === 0) return undefined;
  if (realAgents.length > 1) {
    // Multi-agent install with no `cfg.org` opt-in. Stay silent
    // (locked design default #7).
    return undefined;
  }

  const solo = realAgents[0];
  // `realAgents.length === 1` is verified above, so this assert is
  // a type-narrowing guard for `noUncheckedIndexedAccess`.
  if (!solo) return undefined;
  return {
    topOrder: solo,
    members: {
      [solo]: {
        department: SOLO_DEPARTMENT,
        reportsTo: null,
        role: SOLO_ROLE,
        source: "auto",
      },
    },
    departments: { [SOLO_DEPARTMENT]: [solo] },
    // No edges: a single-member graph has no peers / managers.
    edges: [],
    mode: "derived",
  };
}

function collectRealAgents(cfg: BrigadeConfig): string[] {
  const out: string[] = [];
  const agents = cfg.agents ?? {};
  for (const [id, value] of Object.entries(agents)) {
    if (id === "defaults") continue;
    if (!value || typeof value !== "object") continue;
    out.push(id);
  }
  return out.sort();
}
