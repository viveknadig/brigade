/**
 * Brigade `brigade org init` starter templates (Stage C).
 *
 * Each template returns a JSON snippet of the cfg fragments the
 * `brigade org init` command writes into `brigade.json`:
 *
 *   {
 *     org: BrigadeOrgConfig,
 *     agents: Record<string, { org: AgentOrgBlock }>,
 *   }
 *
 * The four templates are:
 *
 *   - `solo`     : single agent "main" as Chief of Staff (Office dept).
 *                  Mirrors the auto-derive output but materialises it on
 *                  disk so the operator can edit + extend it.
 *   - `family`   : three flat peers — main + helper + scheduler — in the
 *                  "household" department. No manager chain.
 *   - `company`  : multi-department small company shape — exec / eng /
 *                  ops, four agents. Demonstrates the manager chain.
 *   - `custom`   : empty scaffold — `topOrder: "main"` + mode "derived"
 *                  with no agents. The operator fills it in from the
 *                  editor.
 *
 * STAGE-C CONTRACT
 * ----------------
 *   - Templates are STATIC fixtures. No runtime branching, no env
 *     reads, no filesystem access. The command layer (org-cmd.ts) is
 *     the only consumer; tests pin the shape directly.
 *   - Templates target the field shapes declared in
 *     `src/config/io.ts` (`BrigadeOrgConfig` + `AgentConfig.org`); the
 *     command merges them into the existing config so they do NOT
 *     replace fields the operator has already set.
 *
 * No external agent-codebase
 * identifiers are referenced from this file.
 */

import type { BrigadeOrgConfig } from "../../config/io.js";

/** Per-agent org block — mirrors `AgentConfig.org` (cfg/io.ts). */
export interface OrgAgentTemplateBlock {
  department: string;
  reportsTo: string | null;
  role?: string;
  bio?: string;
}

export interface OrgTemplate {
  /** Stable id — also the value passed to `--template`. */
  id: OrgTemplateId;
  /** One-line description for `brigade org init --help`. */
  summary: string;
  /** The `cfg.org` block this template seeds. */
  org: BrigadeOrgConfig;
  /** Per-agent org blocks keyed by agent id; merged into `cfg.agents`. */
  agents: Record<string, OrgAgentTemplateBlock>;
}

export type OrgTemplateId = "solo" | "family" | "company" | "custom";

const SOLO_TEMPLATE: OrgTemplate = {
  id: "solo",
  summary:
    "Single agent (Chief of Staff) in the office department — materialises the auto-derive output on disk.",
  org: {
    topOrder: "main",
    a2a: { mode: "derived" },
  },
  agents: {
    main: {
      department: "office",
      reportsTo: null,
      role: "Chief of Staff",
    },
  },
};

const FAMILY_TEMPLATE: OrgTemplate = {
  id: "family",
  summary:
    "Three flat peers in the household department (main + helper + scheduler). No manager chain.",
  org: {
    topOrder: "main",
    a2a: { mode: "derived" },
  },
  agents: {
    main: {
      department: "household",
      reportsTo: null,
      role: "Coordinator",
    },
    helper: {
      department: "household",
      reportsTo: null,
      role: "Helper",
    },
    scheduler: {
      department: "household",
      reportsTo: null,
      role: "Scheduler",
    },
  },
};

const COMPANY_TEMPLATE: OrgTemplate = {
  id: "company",
  summary:
    "Small company: exec + engineering + ops departments, four agents, demonstrates the manager chain.",
  org: {
    topOrder: "main",
    a2a: { mode: "derived" },
    departmentHeads: {
      engineering: "eng_lead",
      ops: "ops_lead",
    },
  },
  agents: {
    main: {
      department: "exec",
      reportsTo: null,
      role: "Chief of Staff",
    },
    eng_lead: {
      department: "engineering",
      reportsTo: "main",
      role: "Engineering Lead",
    },
    eng_ic: {
      department: "engineering",
      reportsTo: "eng_lead",
      role: "Engineer",
    },
    ops_lead: {
      department: "ops",
      reportsTo: "main",
      role: "Operations Lead",
    },
  },
};

const CUSTOM_TEMPLATE: OrgTemplate = {
  id: "custom",
  summary:
    "Empty scaffold: `topOrder: \"main\"` + mode `derived` with no agents. Fill in from $EDITOR.",
  org: {
    topOrder: "main",
    a2a: { mode: "derived" },
  },
  agents: {},
};

const TEMPLATE_INDEX: Record<OrgTemplateId, OrgTemplate> = {
  solo: SOLO_TEMPLATE,
  family: FAMILY_TEMPLATE,
  company: COMPANY_TEMPLATE,
  custom: CUSTOM_TEMPLATE,
};

/**
 * Look up a template by id. Returns `undefined` for an unknown id so
 * the CLI layer can print a helpful list-of-valid-options error.
 */
export function getOrgTemplate(id: string): OrgTemplate | undefined {
  if (id !== "solo" && id !== "family" && id !== "company" && id !== "custom") {
    return undefined;
  }
  return TEMPLATE_INDEX[id];
}

/** All template ids in stable order. */
export function listOrgTemplateIds(): OrgTemplateId[] {
  return ["solo", "family", "company", "custom"];
}

/** Convenience iterator for help-text rendering. */
export function listOrgTemplates(): OrgTemplate[] {
  return listOrgTemplateIds().map((id) => TEMPLATE_INDEX[id]);
}
