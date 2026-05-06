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

test("calculateCooldownMs: tier ladder (with ±10% jitter)", () => {
  // Jitter means we can't assert exact equality. Run each tier ten times
  // and assert the result is within ±10% of the tier base.
  function inRange(value: number, base: number): boolean {
    const tolerance = base * 0.105; // tiny slack for rounding
    return value >= base - tolerance && value <= base + tolerance;
  }
  for (let i = 0; i < 10; i++) {
    assert.ok(inRange(calculateCooldownMs(0), 30_000), `tier 1 in range`);
    assert.ok(inRange(calculateCooldownMs(1), 30_000), `tier 1 in range`);
    assert.ok(inRange(calculateCooldownMs(2), 60_000), `tier 2 in range`);
    assert.ok(inRange(calculateCooldownMs(3), 5 * 60_000), `tier 3 in range`);
    assert.ok(inRange(calculateCooldownMs(10), 5 * 60_000), `tier 3+ in range`);
  }
});

test("calculateCooldownMs: jitter actually varies the result across calls", () => {
  // 50 calls at the same tier should produce at least 5 distinct values —
  // otherwise the jitter function isn't doing its job.
  const samples = new Set<number>();
  for (let i = 0; i < 50; i++) samples.add(calculateCooldownMs(1));
  assert.ok(samples.size >= 5, `expected ≥5 distinct samples, got ${samples.size}`);
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

test("markProfileFailure: rate_limit sets cooldownUntil for ~30s (with ±10% jitter)", () => {
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
  // Tier-1 base is 30s. Jitter is ±10% so cooldown lands in [27s, 33s].
  // Allow a tiny extra slack for clock skew between `before` and the
  // internal Date.now() inside markProfileFailure.
  const elapsed = stats.cooldownUntil! - before;
  assert.ok(elapsed >= 26_000 && elapsed <= 34_000, `expected ~30s ± jitter, got ${elapsed}ms`);
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
