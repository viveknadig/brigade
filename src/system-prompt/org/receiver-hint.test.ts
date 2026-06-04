/**
 * Stage-D tests for the receiver-hint renderer.
 *
 * Contract:
 *   - Returns `undefined` for events whose contextKey is not kind-tagged
 *     (legacy A2A / cron / heartbeat events pass through unchanged).
 *   - Renders a `## New work from <dept>` heading + framing line for
 *     each of the three kinds (delegation / escalation / review).
 *   - Heading falls back to the sender's agent id when no department is
 *     encoded in the contextKey.
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw tokens.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { encodeDeliveryKindContextKey } from "../../agents/org/delivery-kind.js";
import {
  renderReceiverHint,
  renderReceiverHints,
} from "./receiver-hint.js";

describe("renderReceiverHint — undefined for non-kind events", () => {
  it("returns undefined for an event with no contextKey", () => {
    assert.equal(renderReceiverHint({ text: "hello" }), undefined);
  });

  it("returns undefined for a legacy a2a:from:<sender> contextKey", () => {
    assert.equal(
      renderReceiverHint({ contextKey: "a2a:from:main" }),
      undefined,
    );
    assert.equal(
      renderReceiverHint({ contextKey: "cron:run:42" }),
      undefined,
    );
  });

  it("returns undefined for a malformed kind tag", () => {
    assert.equal(
      renderReceiverHint({ contextKey: "brigade-org-kind:bogus:from:main" }),
      undefined,
    );
  });

  it("returns undefined when sender id is missing", () => {
    assert.equal(
      renderReceiverHint({ contextKey: "brigade-org-kind:delegation" }),
      undefined,
    );
  });
});

describe("renderReceiverHint — delegation framing", () => {
  it("renders heading + body with dept + role", () => {
    const contextKey = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "logistics",
      fromRole: "Head of Logistics",
      fromDepartment: "logistics",
    });
    assert.ok(contextKey);
    const out = renderReceiverHint({ contextKey });
    assert.ok(out);
    assert.match(out, /## New work from logistics/);
    assert.match(out, /Head of Logistics \(logistics\)/);
    assert.match(out, /delegation \(please own the work\)/);
  });

  it("falls back to agent id when department is missing", () => {
    const contextKey = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "loner",
    });
    assert.ok(contextKey);
    const out = renderReceiverHint({ contextKey });
    assert.ok(out);
    assert.match(out, /## New work from loner/);
  });
});

describe("renderReceiverHint — escalation framing", () => {
  it("renders the escalation framing for escalation kind", () => {
    const contextKey = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "inventory",
      fromRole: "Inventory Lead",
      fromDepartment: "logistics",
    });
    assert.ok(contextKey);
    const out = renderReceiverHint({ contextKey });
    assert.ok(out);
    assert.match(out, /escalation \(a downstream member needs your call\)/);
  });
});

describe("renderReceiverHint — review framing", () => {
  it("renders the review framing for review kind", () => {
    const contextKey = encodeDeliveryKindContextKey({
      kind: "review",
      fromAgentId: "designer",
      fromRole: "Lead Designer",
      fromDepartment: "design",
    });
    assert.ok(contextKey);
    const out = renderReceiverHint({ contextKey });
    assert.ok(out);
    assert.match(out, /review request \(feedback only — do not execute\)/);
  });
});

describe("renderReceiverHints — batched rendering", () => {
  it("returns undefined when no event carries kind metadata", () => {
    const out = renderReceiverHints([
      { contextKey: "a2a:from:main" },
      { contextKey: null },
    ]);
    assert.equal(out, undefined);
  });

  it("joins hints from multiple tagged events with a blank line", () => {
    const ck1 = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "a",
      fromDepartment: "x",
    });
    const ck2 = encodeDeliveryKindContextKey({
      kind: "escalation",
      fromAgentId: "b",
      fromDepartment: "y",
    });
    const out = renderReceiverHints([{ contextKey: ck1 }, { contextKey: ck2 }]);
    assert.ok(out);
    const blocks = out.split("\n\n");
    assert.equal(blocks.length, 2);
    assert.match(blocks[0] ?? "", /## New work from x/);
    assert.match(blocks[1] ?? "", /## New work from y/);
  });

  it("skips legacy events but renders tagged ones in the same batch", () => {
    const ck = encodeDeliveryKindContextKey({
      kind: "delegation",
      fromAgentId: "z",
      fromDepartment: "ops",
    });
    const out = renderReceiverHints([
      { contextKey: "a2a:from:legacy" },
      { contextKey: ck },
    ]);
    assert.ok(out);
    assert.match(out, /## New work from ops/);
    assert.doesNotMatch(out, /legacy/);
  });
});
