/**
 * Tests for the single-line org anchor rendered when `cfg.org` is
 * present. Contract pinned by these tests:
 *
 *   - `graph === undefined` → `renderOrgBlock` returns `undefined`.
 *   - Unknown `callerAgentId` → returns `undefined` (the assembler
 *     treats that as "no anchor").
 *   - Top-of-org anchor: phrasing is
 *       "Org: you are <id>, <role>, top-of-org. Call org({action:\"describe\"}) for direct reports + departments."
 *   - Non-top anchor: phrasing is
 *       "Org: you are <id>, <role> in <department>, reports to <Y>. Call org({action:\"describe\"}) for peers + reachability."
 *   - Missing `role` is omitted gracefully (bare id, no "(undefined)" /
 *     no "null in <dept>" artefacts).
 *   - The rendered anchor is EXACTLY ONE line — no embedded newlines.
 *
 * No external agent-codebase tokens.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { OrgGraph } from "../../agents/org/types.js";
import { renderOrgBlock } from "./render-org-block.js";

/**
 * Hardcoded fixture for the three example shapes the anchor contract
 * names: a top-of-org agent (`main`), a department head (`logistics`),
 * and a leaf inside that department (`inventory`). A `marketing`
 * department is included so a multi-dept install is exercised.
 */
const FIXTURE: OrgGraph = {
  topOrder: "main",
  mode: "derived",
  members: {
    main: {
      department: "office",
      reportsTo: null,
      role: "Chief of Staff",
      bio: "Routes work across the org.",
      source: "explicit",
    },
    logistics: {
      department: "logistics",
      reportsTo: "main",
      role: "Head of Logistics",
      bio: "Inventory + supplier ops.",
      source: "explicit",
    },
    inventory: {
      department: "logistics",
      reportsTo: "logistics",
      role: "Inventory Lead",
      source: "explicit",
    },
    receiving: {
      department: "logistics",
      reportsTo: "logistics",
      role: "Receiving Lead",
      source: "explicit",
    },
    marketing: {
      department: "marketing",
      reportsTo: "main",
      role: "Head of Marketing",
      source: "explicit",
    },
  },
  departments: {
    office: ["main"],
    logistics: ["inventory", "logistics", "receiving"],
    marketing: ["marketing"],
  },
  edges: [],
};

describe("renderOrgBlock — undefined / unknown caller short-circuit", () => {
  it("returns undefined when graph is undefined (legacy mode → no anchor)", () => {
    const out = renderOrgBlock(undefined, "main");
    assert.equal(out, undefined);
  });

  it("returns undefined when caller agent is not a member of the graph", () => {
    const out = renderOrgBlock(FIXTURE, "stranger");
    assert.equal(out, undefined);
  });
});

describe("renderOrgBlock — top-of-org caller (main)", () => {
  it("anchors as 'top-of-org' with the org-tool pointer", () => {
    const out = renderOrgBlock(FIXTURE, "main");
    assert.equal(
      out,
      `Org: you are main, Chief of Staff, top-of-org. Call org({action:"describe"}) for direct reports + departments.`,
    );
  });

  it("emits exactly one line (no embedded newlines)", () => {
    const out = renderOrgBlock(FIXTURE, "main");
    assert.ok(out);
    assert.equal(out.split("\n").length, 1, "anchor must be exactly one line");
    assert.doesNotMatch(out, /\r/, "anchor must not contain carriage returns");
  });

  it("does NOT advertise the legacy multi-section vocabulary", () => {
    const out = renderOrgBlock(FIXTURE, "main");
    assert.ok(out);
    assert.doesNotMatch(out, /^## Org$/m);
    assert.doesNotMatch(out, /Direct reports:/);
    assert.doesNotMatch(out, /Department peers/);
    assert.doesNotMatch(out, /Other departments:/);
    assert.doesNotMatch(out, /Top of org:/);
    assert.doesNotMatch(out, /Routing:/);
    assert.doesNotMatch(out, /delegate_to_department/);
    assert.doesNotMatch(out, /Routes work across the org\./);
  });
});

describe("renderOrgBlock — non-top caller (department head + leaf)", () => {
  it("department head anchors with manager + dept + reachability pointer", () => {
    const out = renderOrgBlock(FIXTURE, "logistics");
    assert.equal(
      out,
      `Org: you are logistics, Head of Logistics in logistics, reports to main. Call org({action:"describe"}) for peers + reachability.`,
    );
  });

  it("leaf anchors with its actual manager (the dept head, not topOrder)", () => {
    const out = renderOrgBlock(FIXTURE, "inventory");
    assert.equal(
      out,
      `Org: you are inventory, Inventory Lead in logistics, reports to logistics. Call org({action:"describe"}) for peers + reachability.`,
    );
  });

  it("emits exactly one line (no embedded newlines)", () => {
    for (const caller of ["logistics", "inventory", "marketing"]) {
      const out = renderOrgBlock(FIXTURE, caller);
      assert.ok(out, `expected anchor for ${caller}`);
      assert.equal(
        out.split("\n").length,
        1,
        `anchor for ${caller} must be exactly one line`,
      );
      assert.doesNotMatch(out, /\r/, `anchor for ${caller} must have no CR`);
    }
  });
});

describe("renderOrgBlock — role omission graceful", () => {
  it("falls back to bare id when role is absent (non-top caller)", () => {
    const noRole: OrgGraph = {
      topOrder: "main",
      mode: "derived",
      members: {
        main: { department: "office", reportsTo: null, source: "explicit" },
        helper: { department: "office", reportsTo: "main", source: "explicit" },
      },
      departments: { office: ["main", "helper"] },
      edges: [],
    };
    const out = renderOrgBlock(noRole, "helper");
    assert.equal(
      out,
      `Org: you are helper in office, reports to main. Call org({action:"describe"}) for peers + reachability.`,
    );
    assert.doesNotMatch(out, /undefined/i);
    assert.doesNotMatch(out, /null/);
  });

  it("falls back to bare id when role is absent (top-of-org caller)", () => {
    const noRole: OrgGraph = {
      topOrder: "main",
      mode: "derived",
      members: {
        main: { department: "office", reportsTo: null, source: "auto" },
      },
      departments: { office: ["main"] },
      edges: [],
    };
    const out = renderOrgBlock(noRole, "main");
    assert.equal(
      out,
      `Org: you are main, top-of-org. Call org({action:"describe"}) for direct reports + departments.`,
    );
    assert.doesNotMatch(out, /undefined/i);
    assert.doesNotMatch(out, /null/);
  });

  it("treats a whitespace-only role as missing", () => {
    const blankRole: OrgGraph = {
      topOrder: "main",
      mode: "derived",
      members: {
        main: { department: "office", reportsTo: null, role: "   ", source: "explicit" },
        helper: { department: "office", reportsTo: "main", role: "  \t  ", source: "explicit" },
      },
      departments: { office: ["main", "helper"] },
      edges: [],
    };
    assert.equal(
      renderOrgBlock(blankRole, "main"),
      `Org: you are main, top-of-org. Call org({action:"describe"}) for direct reports + departments.`,
    );
    assert.equal(
      renderOrgBlock(blankRole, "helper"),
      `Org: you are helper in office, reports to main. Call org({action:"describe"}) for peers + reachability.`,
    );
  });
});

describe("renderOrgBlock — anchor shape invariants", () => {
  it("never includes the bio sentence (defer to org({action:\"describe\"}))", () => {
    // main has a bio in FIXTURE — the anchor must NOT include it.
    const out = renderOrgBlock(FIXTURE, "main");
    assert.ok(out);
    assert.doesNotMatch(out, /Routes work across the org\./);
    // logistics also has a bio — same expectation.
    const out2 = renderOrgBlock(FIXTURE, "logistics");
    assert.ok(out2);
    assert.doesNotMatch(out2, /Inventory \+ supplier ops\./);
  });

  it("anchor always ends with the org-tool pointer sentence", () => {
    for (const caller of ["main", "logistics", "inventory", "marketing"]) {
      const out = renderOrgBlock(FIXTURE, caller);
      assert.ok(out, `expected anchor for ${caller}`);
      assert.match(
        out,
        /Call org\(\{action:"describe"\}\) for /,
        `anchor for ${caller} must point at the org tool`,
      );
    }
  });
});
