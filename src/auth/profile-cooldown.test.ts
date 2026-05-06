import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateCooldownMs,
  calculateDisabledMs,
  clearExpiredCooldowns,
  getCooldownStatus,
  isProfileEligible,
  markProfileFailure,
  markProfileSuccess,
  orderProfilesForSelection,
  type ProfileStateFile,
} from "./profile-cooldown.js";

function freshState(): ProfileStateFile {
  return { version: 1, usageStats: {} };
}

test("calculateCooldownMs: tier ladder", () => {
  assert.equal(calculateCooldownMs(0), 30_000);
  assert.equal(calculateCooldownMs(1), 30_000);
  assert.equal(calculateCooldownMs(2), 60_000);
  assert.equal(calculateCooldownMs(3), 5 * 60_000);
  assert.equal(calculateCooldownMs(10), 5 * 60_000);
});

test("calculateDisabledMs: auth_permanent base 10m, doubles, capped at 60m", () => {
  assert.equal(calculateDisabledMs("auth_permanent", 1), 10 * 60_000);
  assert.equal(calculateDisabledMs("auth_permanent", 2), 20 * 60_000);
  assert.equal(calculateDisabledMs("auth_permanent", 3), 40 * 60_000);
  assert.equal(calculateDisabledMs("auth_permanent", 4), 60 * 60_000); // capped
  assert.equal(calculateDisabledMs("auth_permanent", 100), 60 * 60_000);
});

test("calculateDisabledMs: billing base 5h, capped at 24h", () => {
  assert.equal(calculateDisabledMs("billing", 1), 5 * 60 * 60_000);
  assert.equal(calculateDisabledMs("billing", 2), 10 * 60 * 60_000);
  assert.equal(calculateDisabledMs("billing", 3), 20 * 60 * 60_000);
  assert.equal(calculateDisabledMs("billing", 4), 24 * 60 * 60_000); // capped
});

test("getCooldownStatus: empty stats → not cooled, not disabled", () => {
  const s = getCooldownStatus(undefined);
  assert.equal(s.cooled, false);
  assert.equal(s.disabled, false);
});

test("getCooldownStatus: future cooldownUntil flags cooled", () => {
  const future = Date.now() + 10_000;
  const s = getCooldownStatus({ cooldownUntil: future, cooldownReason: "rate_limit" });
  assert.equal(s.cooled, true);
  assert.equal(s.cooldownUntil, future);
  assert.equal(s.reason, "rate_limit");
});

test("getCooldownStatus: past cooldownUntil → not cooled", () => {
  const past = Date.now() - 10_000;
  const s = getCooldownStatus({ cooldownUntil: past, cooldownReason: "rate_limit" });
  assert.equal(s.cooled, false);
});

test("getCooldownStatus: model-scoped cooldown bypasses for other models", () => {
  const future = Date.now() + 10_000;
  const stats = {
    cooldownUntil: future,
    cooldownReason: "rate_limit" as const,
    cooldownModel: "claude-opus-4-7",
  };
  const sameModel = getCooldownStatus(stats, { forModel: "claude-opus-4-7" });
  const otherModel = getCooldownStatus(stats, { forModel: "gpt-4o" });
  assert.equal(sameModel.cooled, true);
  assert.equal(otherModel.cooled, false);
});

test("markProfileFailure: rate_limit sets cooldownUntil for at least 30s", () => {
  const before = Date.now();
  // save:false so we don't actually write to disk in tests
  const next = markProfileFailure({
    agentId: "test-agent-no-disk",
    state: freshState(),
    profileId: "anthropic:default",
    reason: "rate_limit",
    save: false,
  });
  const stats = next.usageStats!["anthropic:default"]!;
  assert.equal(stats.cooldownReason, "rate_limit");
  assert.ok(stats.cooldownUntil! >= before + 30_000);
  assert.equal(stats.errorCount, 1);
});

test("markProfileFailure: billing puts profile on disabled lane", () => {
  const next = markProfileFailure({
    agentId: "test-agent-no-disk",
    state: freshState(),
    profileId: "openai:default",
    reason: "billing",
    save: false,
  });
  const stats = next.usageStats!["openai:default"]!;
  assert.ok(stats.disabledUntil! > Date.now() + 60 * 60_000); // > 1h
  assert.equal(stats.disabledReason, "billing");
});

test("markProfileFailure: format reason is recorded but no cooldown applied", () => {
  const next = markProfileFailure({
    agentId: "test-agent-no-disk",
    state: freshState(),
    profileId: "anthropic:default",
    reason: "format",
    save: false,
  });
  const stats = next.usageStats!["anthropic:default"]!;
  assert.equal(stats.cooldownUntil, undefined);
  assert.equal(stats.disabledUntil, undefined);
  assert.equal(stats.errorCount, 1);
});

test("markProfileSuccess: clears cooldown + disabled state, sets lastUsed + lastGood", () => {
  const startState = markProfileFailure({
    agentId: "test-agent-no-disk",
    state: freshState(),
    profileId: "anthropic:default",
    reason: "rate_limit",
    save: false,
  });
  const after = markProfileSuccess({
    agentId: "test-agent-no-disk",
    state: startState,
    profileId: "anthropic:default",
    provider: "anthropic",
    save: false,
  });
  const stats = after.usageStats!["anthropic:default"]!;
  assert.equal(stats.cooldownUntil, undefined);
  assert.equal(stats.errorCount, undefined);
  assert.ok(stats.lastUsed! > 0);
  assert.equal(after.lastGood?.["anthropic"], "anthropic:default");
});

test("clearExpiredCooldowns: removes past cooldownUntil + zeros errorCount", () => {
  const state: ProfileStateFile = {
    version: 1,
    usageStats: {
      "p1": {
        cooldownUntil: Date.now() - 1000,
        cooldownReason: "rate_limit",
        errorCount: 5,
      },
    },
  };
  const next = clearExpiredCooldowns(state);
  const stats = next.usageStats!["p1"]!;
  assert.equal(stats.cooldownUntil, undefined);
  assert.equal(stats.errorCount, 0);
});

test("isProfileEligible: cooled profiles are ineligible", () => {
  const state: ProfileStateFile = {
    version: 1,
    usageStats: {
      "cooled": { cooldownUntil: Date.now() + 10_000, cooldownReason: "rate_limit" },
      "fine": { lastUsed: Date.now() },
    },
  };
  assert.equal(isProfileEligible(state, "cooled"), false);
  assert.equal(isProfileEligible(state, "fine"), true);
});

test("orderProfilesForSelection: eligibles first, then cooled by soonest expiry", () => {
  const now = 1_700_000_000_000;
  const state: ProfileStateFile = {
    version: 1,
    usageStats: {
      "a": { lastUsed: now - 10_000 },           // eligible, oldest used → first
      "b": { lastUsed: now - 1_000 },            // eligible, newest used
      "cooled-soon": { cooldownUntil: now + 1_000, cooldownReason: "rate_limit" },
      "cooled-later": { cooldownUntil: now + 10_000, cooldownReason: "rate_limit" },
    },
  };
  const order = orderProfilesForSelection({
    state,
    provider: "anthropic",
    profileIds: ["b", "a", "cooled-later", "cooled-soon"],
    now,
  });
  // Eligible first (sorted by lastUsed asc), then cooled (sorted by expiry asc).
  assert.deepEqual(order, ["a", "b", "cooled-soon", "cooled-later"]);
});

test("orderProfilesForSelection: preferredProfile floats to the head when eligible", () => {
  const now = 1_700_000_000_000;
  const state: ProfileStateFile = {
    version: 1,
    usageStats: {
      "a": { lastUsed: now - 10_000 },
      "b": { lastUsed: now - 1_000 },
      "preferred": { lastUsed: now - 5_000 },
    },
  };
  const order = orderProfilesForSelection({
    state,
    provider: "anthropic",
    profileIds: ["a", "b", "preferred"],
    preferredProfile: "preferred",
    now,
  });
  assert.equal(order[0], "preferred");
});

test("markProfileFailure: error count decays after failure window expires", () => {
  // Start with a profile that failed 25 hours ago (> 24h failure window).
  const stale = freshState();
  stale.usageStats!["p1"] = {
    errorCount: 4,
    lastFailureAt: Date.now() - 25 * 60 * 60_000,
  };
  const next = markProfileFailure({
    agentId: "test-agent-no-disk",
    state: stale,
    profileId: "p1",
    reason: "rate_limit",
    save: false,
  });
  // Decayed → next error counts as 1, not 5.
  const stats = next.usageStats!["p1"]!;
  assert.equal(stats.errorCount, 1);
});
