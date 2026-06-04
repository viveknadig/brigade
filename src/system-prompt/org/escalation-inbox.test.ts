/**
 * Stage-D tests for the topOrder escalation-inbox renderer.
 *
 * Contract:
 *   - Renders for the topOrder agent when at least one event in the
 *     batch carries `kind === "escalation"`.
 *   - Returns `undefined` for non-topOrder callers (the renderer is a
 *     topOrder-only attention surface).
 *   - Returns `undefined` when no event in the batch is an escalation
 *     (delegation / review / legacy events are filtered).
 *   - Truncates long lists with a "+N more escalation(s)" tail.
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw tokens.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { encodeDeliveryKindContextKey } from "../../agents/org/delivery-kind.js";
import type { OrgGraph } from "../../agents/org/types.js";
import {
  ESCALATION_INBOX_LIST_CAP,
  renderEscalationInbox,
} from "./escalation-inbox.js";

const FIXTURE_GRAPH: OrgGraph = {
  topOrder: "main",
  mode: "derived",
  members: {
    main: {
      department: "office",
      reportsTo: null,
      role: "Chief of Staff",
      source: "explicit",
    },
    logistics: {
      department: "logistics",
      reportsTo: "main",
      role: "Head of Logistics",
      source: "explicit",
    },
    inventory: {
      department: "logistics",
      reportsTo: "logistics",
      role: "Inventory Lead",
      source: "explicit",
    },
  },
  departments: {
    office: ["main"],
    logistics: ["inventory", "logistics"],
  },
  edges: [],
};

describe("renderEscalationInbox — short-circuit cases", () => {
  it("returns undefined when graph is missing", () => {
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: undefined,
      events: [],
    });
    assert.equal(out, undefined);
  });

  it("returns undefined for a non-topOrder caller, even with escalations queued", () => {
    const ck = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "inventory",
      fromRole: "Inventory Lead",
      fromDepartment: "logistics",
    });
    const out = renderEscalationInbox({
      callerAgentId: "logistics",
      graph: FIXTURE_GRAPH,
      events: [{ contextKey: ck }],
    });
    assert.equal(out, undefined);
  });

  it("returns undefined when no event is tagged as an escalation", () => {
    const delegationCk = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "logistics",
      fromDepartment: "logistics",
    });
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events: [{ contextKey: delegationCk }, { contextKey: "a2a:from:legacy" }],
    });
    assert.equal(out, undefined);
  });

  it("returns undefined for an empty event list", () => {
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events: [],
    });
    assert.equal(out, undefined);
  });
});

describe("renderEscalationInbox — topOrder render", () => {
  it("renders a single escalation with role + dept", () => {
    const ck = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "inventory",
      fromRole: "Inventory Lead",
      fromDepartment: "logistics",
    });
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events: [{ contextKey: ck }],
    });
    assert.ok(out);
    const lines = out.split("\n");
    assert.equal(lines[0], "## Escalation Inbox");
    assert.match(lines[1] ?? "", /- Inventory Lead \(inventory\) from logistics/);
  });

  it("renders multiple escalations as separate list items", () => {
    const ck1 = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "inventory",
      fromRole: "Inventory Lead",
      fromDepartment: "logistics",
    });
    const ck2 = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "logistics",
      fromRole: "Head of Logistics",
      fromDepartment: "logistics",
    });
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events: [{ contextKey: ck1 }, { contextKey: ck2 }],
    });
    assert.ok(out);
    assert.match(out, /Inventory Lead \(inventory\)/);
    assert.match(out, /Head of Logistics \(logistics\)/);
  });

  it("filters non-escalation kinds out of the list", () => {
    const escalation = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "inventory",
      fromDepartment: "logistics",
    });
    const delegation = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "logistics",
      fromDepartment: "logistics",
    });
    const review = encodeDeliveryKindContextKey({
      kind: "review",
      fromAgentId: "inventory",
      fromDepartment: "logistics",
    });
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events: [
        { contextKey: delegation },
        { contextKey: escalation },
        { contextKey: review },
        { contextKey: "a2a:from:legacy" },
      ],
    });
    assert.ok(out);
    const lines = out.split("\n");
    // Heading + exactly one escalation line.
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? "", /inventory/);
  });

  it("truncates beyond the list cap with a +N more tail", () => {
    const events = Array.from({ length: ESCALATION_INBOX_LIST_CAP + 3 }, (_, i) => ({
      contextKey: encodeDeliveryKindContextKey({
        kind: "escalation",
        fromAgentId: `agent${i}`,
        fromDepartment: "logistics",
      }),
    }));
    const out = renderEscalationInbox({
      callerAgentId: "main",
      graph: FIXTURE_GRAPH,
      events,
    });
    assert.ok(out);
    assert.match(out, /\(\+3 more escalations\)/);
  });
});
