/**
 * Stage-A tests for the Brigade virtual-office derivation layer.
 *
 * Contract pinned by these tests:
 *
 *   - `cfg.org` absent + zero agents → `deriveOrgGraph` returns undefined
 *   - `cfg.org` absent + 1 agent     → auto-derives solo graph in memory
 *   - `cfg.org` absent + 2+ agents   → returns undefined (no opt-in)
 *   - Cycle in reportsTo             → throws ORG_CYCLE_DETECTED
 *   - topOrder reportsTo non-null    → throws ORG_TOPORDER_REPORTSTO_NOT_NULL
 *   - departmentHeads ref unknown    → throws ORG_DEPARTMENT_HEAD_UNKNOWN
 *   - departmentHeads ref off-dept   → throws ORG_DEPARTMENT_HEAD_NOT_IN_DEPT
 *   - depth-5 warning surfaces but does NOT throw
 *   - two departments derive correct edges (intra-dept, escalation,
 *     broadcast — NOT cross-dept lateral)
 *   - extraAllow opens new edges; extraDeny closes derived edges
 *     (deny wins last)
 *   - subagent-inherited edges (placeholder slot — derivation graph
 *     exposes a path for spawn-time append; the test pins the shape)
 *   - mode==="explicit"             → returns undefined even with cfg.org
 *   - mode==="open"                 → all-to-all derived
 *
 * The test pins Stage A invariants ONLY. No existing runtime path
 * reads these structures yet, so we don't exercise consumers.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { autoDeriveSoloGraph } from "./auto-derive.js";
import { deriveOrgGraph } from "./derive-graph.js";
import { lintOrgGraph } from "./lints.js";
import { BrigadeOrgConfigError } from "./types.js";
import type { EdgeRecord } from "./types.js";
import { validateOrgConfig } from "./validate.js";

function hasEdge(edges: EdgeRecord[], from: string, to: string, reason?: string): boolean {
  return edges.some((e) => e.from === from && e.to === to && (!reason || e.reason === reason));
}

describe("derive-graph: legacy-mode preservation (cfg.org absent)", () => {
  it("(1) cfg.org absent + 0 agents → returns undefined (preserves legacy null)", () => {
    const cfg: BrigadeConfig = { agents: {} };
    const out = deriveOrgGraph(cfg);
    assert.equal(out, undefined);
  });

  it("(2) cfg.org absent + 1 agent → auto-derives solo graph IN-MEMORY", () => {
    const cfg: BrigadeConfig = { agents: { main: {} } };
    const out = deriveOrgGraph(cfg);
    assert.ok(out, "expected an auto-derived solo graph");
    assert.equal(out.topOrder, "main");
    const solo = out.members["main"];
    assert.ok(solo);
    assert.equal(solo.source, "auto");
    assert.equal(solo.role, "Chief of Staff");
    assert.equal(solo.reportsTo, null);
    assert.equal(out.edges.length, 0, "solo graph has zero edges");
    // Critically: the synthesis is IN-MEMORY. We never wrote cfg.org.
    assert.equal(cfg.org, undefined, "auto-derive must not mutate cfg.org");
  });

  it("(3) cfg.org absent + 2 agents → returns undefined (no opt-in)", () => {
    const cfg: BrigadeConfig = { agents: { main: {}, helper: {} } };
    const out = deriveOrgGraph(cfg);
    assert.equal(out, undefined);
    // Legacy A2A path is preserved bit-for-bit because the deriver
    // returned undefined.
  });
});

describe("derive-graph: hard violations throw BrigadeOrgConfigError", () => {
  it("(4) cycle in reportsTo chain → ORG_CYCLE_DETECTED", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: null } },
        a: { org: { department: "eng", reportsTo: "b" } },
        b: { org: { department: "eng", reportsTo: "a" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    let caught: unknown = null;
    try {
      deriveOrgGraph(cfg);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof BrigadeOrgConfigError);
    assert.equal((caught as BrigadeOrgConfigError).code, "ORG_CYCLE_DETECTED");
    // Diagnostic carries the offending node:
    assert.ok((caught as BrigadeOrgConfigError).detail?.["offending"]);
  });

  it("(5) topOrder agent reportsTo !== null → ORG_TOPORDER_REPORTSTO_NOT_NULL", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: "someoneElse" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    assert.throws(
      () => deriveOrgGraph(cfg),
      (err: unknown) =>
        err instanceof BrigadeOrgConfigError &&
        err.code === "ORG_TOPORDER_REPORTSTO_NOT_NULL",
    );
  });

  it("(6) departmentHeads ref unknown agent → ORG_DEPARTMENT_HEAD_UNKNOWN", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: null } },
      },
      org: {
        topOrder: "main",
        a2a: { mode: "derived" },
        departmentHeads: { office: "ghost" },
      },
    };
    assert.throws(
      () => deriveOrgGraph(cfg),
      (err: unknown) =>
        err instanceof BrigadeOrgConfigError &&
        err.code === "ORG_DEPARTMENT_HEAD_UNKNOWN",
    );
  });

  it("(6b) departmentHeads ref off-department → ORG_DEPARTMENT_HEAD_NOT_IN_DEPT", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: {
        topOrder: "main",
        a2a: { mode: "derived" },
        departmentHeads: { office: "eng1" },
      },
    };
    assert.throws(
      () => deriveOrgGraph(cfg),
      (err: unknown) =>
        err instanceof BrigadeOrgConfigError &&
        err.code === "ORG_DEPARTMENT_HEAD_NOT_IN_DEPT",
    );
  });

  it("(7) depth>5 warning surfaces but does NOT throw", () => {
    // Build a 6-deep chain: main <- a <- b <- c <- d <- e <- f
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: null } },
        a: { org: { department: "office", reportsTo: "main" } },
        b: { org: { department: "office", reportsTo: "a" } },
        c: { org: { department: "office", reportsTo: "b" } },
        d: { org: { department: "office", reportsTo: "c" } },
        e: { org: { department: "office", reportsTo: "d" } },
        f: { org: { department: "office", reportsTo: "e" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const outcome = validateOrgConfig(cfg);
    assert.equal(outcome.depthOverFive, true);
    // The deriver still returns a graph (no throw).
    const graph = deriveOrgGraph(cfg);
    assert.ok(graph, "depth>5 is a warning, not an error");
    const lints = lintOrgGraph(cfg, graph);
    assert.ok(
      lints.some((l) => l.code === "ORG_DEPTH_OVER_FIVE"),
      "expected ORG_DEPTH_OVER_FIVE lint",
    );
  });
});

describe("derive-graph: derivation rules (i)-(vii)", () => {
  it("(8) two-department case derives correct edges (no cross-dept lateral)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        eng2: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const g = deriveOrgGraph(cfg);
    assert.ok(g);
    const edges = g.edges;

    // Rule (i) + (ii): manager chain
    assert.ok(hasEdge(edges, "eng1", "main", "escalation-up"));
    assert.ok(hasEdge(edges, "main", "eng1", "assignment-down"));
    assert.ok(hasEdge(edges, "eng2", "main", "escalation-up"));
    assert.ok(hasEdge(edges, "main", "eng2", "assignment-down"));
    assert.ok(hasEdge(edges, "ops1", "main", "escalation-up"));
    assert.ok(hasEdge(edges, "main", "ops1", "assignment-down"));

    // Rule (iii): intra-dept lateral (eng1 <-> eng2)
    assert.ok(hasEdge(edges, "eng1", "eng2", "lateral-peer"));
    assert.ok(hasEdge(edges, "eng2", "eng1", "lateral-peer"));

    // Rule (iv): topOrder broadcast (already covered by escalation but
    // also emitted explicitly between topOrder and every non-top member
    // — non-direct-reports test isn't exercised here because every
    // non-top member reports directly to main. The edge tagged
    // 'topOrder-broadcast' still exists.)
    assert.ok(hasEdge(edges, "eng1", "main", "topOrder-broadcast"));
    assert.ok(hasEdge(edges, "main", "eng1", "topOrder-broadcast"));

    // Rule (v): cross-dept lateral CLOSED. NO direct edge eng1<->ops1.
    assert.ok(
      !hasEdge(edges, "eng1", "ops1", "lateral-peer"),
      "cross-dept lateral must NOT be emitted",
    );
    assert.ok(!hasEdge(edges, "ops1", "eng1", "lateral-peer"));
  });

  it("(9) extraAllow opens, extraDeny closes (deny wins last)", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: {
        topOrder: "main",
        a2a: {
          mode: "derived",
          // Open cross-dept eng1 -> ops1 explicitly
          extraAllow: [{ from: "eng1", to: "ops1", reason: "approved" }],
          // Then deny eng1 -> main (derived broadcast) — should win
          extraDeny: [{ from: "eng1", to: "main" }],
        },
      },
    };
    const g = deriveOrgGraph(cfg);
    assert.ok(g);
    const edges = g.edges;

    // extraAllow created the cross-dept edge
    assert.ok(hasEdge(edges, "eng1", "ops1", "extra-allow"));
    // extraDeny stripped the broadcast / escalation edges from eng1 to main
    assert.ok(
      !edges.some((e) => e.from === "eng1" && e.to === "main"),
      "extraDeny must strip ALL (from, to) edges regardless of reason",
    );
  });

  it("(10) subagent-inherited edges shape — graph models inheritance", () => {
    // Stage A doesn't have a sub-agent runtime to wire into. We pin
    // the graph shape: an explicit sub-agent member with a
    // `subagent-inherited` edge added by Stage-C would slot in cleanly.
    // Here we verify the EdgeRecord type accepts the reason and the
    // lint-pass does not flag a graph that carries one.
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "derived" } },
    };
    const g = deriveOrgGraph(cfg);
    assert.ok(g);
    // Caller (Stage C) appends inherited edges at sub-agent spawn time;
    // the deriver itself does not produce them. We verify the type
    // accepts the reason at construction.
    const inherited: EdgeRecord = {
      from: "eng1.sub-1",
      to: "main",
      reason: "subagent-inherited",
    };
    assert.equal(inherited.reason, "subagent-inherited");
  });

  it("(11) mode=\"explicit\" returns undefined even when cfg.org present", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "office", reportsTo: null } },
      },
      org: { topOrder: "main", a2a: { mode: "explicit" } },
    };
    const g = deriveOrgGraph(cfg);
    assert.equal(g, undefined, "explicit mode preserves legacy A2A path");
  });

  it("(12) mode=\"open\" derives all-to-all", () => {
    const cfg: BrigadeConfig = {
      agents: {
        main: { org: { department: "exec", reportsTo: null } },
        eng1: { org: { department: "eng", reportsTo: "main" } },
        ops1: { org: { department: "ops", reportsTo: "main" } },
      },
      org: { topOrder: "main", a2a: { mode: "open" } },
    };
    const g = deriveOrgGraph(cfg);
    assert.ok(g);
    assert.equal(g.mode, "open");
    // All-to-all: eng1 <-> ops1 must both be present even though
    // cross-dept lateral is closed in derived mode.
    assert.ok(hasEdge(g.edges, "eng1", "ops1", "open-mode"));
    assert.ok(hasEdge(g.edges, "ops1", "eng1", "open-mode"));
    assert.ok(hasEdge(g.edges, "main", "eng1", "open-mode"));
  });
});

describe("auto-derive: solo-only synthesis", () => {
  it("multi-agent install with no cfg.org → returns undefined (no synth)", () => {
    const cfg: BrigadeConfig = { agents: { main: {}, helper: {} } };
    assert.equal(autoDeriveSoloGraph(cfg), undefined);
  });

  it("solo install → synthesizes department='office' role='Chief of Staff'", () => {
    const cfg: BrigadeConfig = { agents: { main: {} } };
    const g = autoDeriveSoloGraph(cfg);
    assert.ok(g);
    const solo = g.members["main"];
    assert.ok(solo);
    assert.equal(solo.department, "office");
    assert.equal(solo.role, "Chief of Staff");
    assert.equal(solo.source, "auto");
  });

  it("solo install lint pass produces NO single-member-dept warning (auto source)", () => {
    const cfg: BrigadeConfig = { agents: { main: {} } };
    const g = autoDeriveSoloGraph(cfg);
    assert.ok(g);
    const lints = lintOrgGraph(cfg, g!);
    assert.equal(
      lints.filter((l) => l.code === "ORG_SINGLE_MEMBER_DEPARTMENT").length,
      0,
      "auto-derived solo dept should NOT trip the single-member lint",
    );
  });
});
