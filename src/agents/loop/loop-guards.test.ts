import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	evaluateDone,
	LoopBudget,
	LoopController,
	NoProgressGuard,
	RepetitionGuard,
	type DoneCheck,
} from "./loop-guards.js";

/**
 * Loop-engineering guards — the deterministic rails. The whole point: an
 * autonomous loop stops on OBJECTIVE signals, never the agent's self-assessment.
 */

describe("LoopBudget — hard caps", () => {
	it("stops at the iteration cap", () => {
		const b = new LoopBudget({ maxIterations: 3 });
		b.tick();
		b.tick();
		assert.equal(b.exceeded().stop, false);
		b.tick();
		assert.match(b.exceeded().reason ?? "", /iteration cap/);
	});
	it("stops at the token budget", () => {
		const b = new LoopBudget({ maxTokens: 100 });
		b.tick(60);
		assert.equal(b.exceeded().stop, false);
		b.tick(50);
		assert.match(b.exceeded().reason ?? "", /token budget/);
	});
	it("ignores non-finite / negative token deltas (stays finite, non-decreasing, clamped)", () => {
		const b = new LoopBudget({ maxTokens: 100 });
		b.tick(NaN);
		assert.equal(b.tokensSpent, 0, "NaN delta ignored");
		b.tick(-50);
		assert.equal(b.tokensSpent, 0, "negative delta clamped to 0");
		b.tick(Infinity);
		assert.equal(b.tokensSpent, 0, "Infinity delta ignored");
		assert.ok(Number.isFinite(b.tokensSpent), "tokensSpent stays finite");
		assert.equal(b.exceeded().stop, false, "garbage deltas never trip the budget");
		// a later valid delta still accumulates and trips the budget.
		b.tick(120);
		assert.equal(b.tokensSpent, 120);
		assert.match(b.exceeded().reason ?? "", /token budget/);
	});
	it("stops at the time budget (injectable clock)", () => {
		let t = 1000;
		const b = new LoopBudget({ maxMs: 500 }, () => t);
		b.tick();
		assert.equal(b.exceeded().stop, false);
		t = 1600; // +600ms
		assert.match(b.exceeded().reason ?? "", /time budget/);
	});
});

describe("NoProgressGuard", () => {
	it("stops after `patience` consecutive unchanged fingerprints", () => {
		const g = new NoProgressGuard(3);
		assert.equal(g.observe("A").stop, false);
		assert.equal(g.observe("A").stop, false); // stale=1
		assert.equal(g.observe("A").stop, false); // stale=2
		assert.match(g.observe("A").reason ?? "", /no progress/); // stale=3
	});
	it("resets when the state changes (real progress)", () => {
		const g = new NoProgressGuard(2);
		g.observe("A");
		g.observe("A"); // stale=1
		assert.equal(g.observe("B").stop, false, "change resets the stall counter");
		assert.equal(g.observe("B").stop, false); // stale=1 again
	});
});

describe("RepetitionGuard", () => {
	it("stops when the same action recurs maxRepeats times in the window", () => {
		const g = new RepetitionGuard({ window: 5, maxRepeats: 3 });
		assert.equal(g.observe("call:brokenTool").stop, false);
		assert.equal(g.observe("call:other").stop, false);
		assert.equal(g.observe("call:brokenTool").stop, false);
		assert.match(g.observe("call:brokenTool").reason ?? "", /repeated 3×/);
	});
	it("rejects maxRepeats > window at construction (would never trip)", () => {
		assert.throws(() => new RepetitionGuard({ window: 2, maxRepeats: 3 }), /maxRepeats/);
	});
	it("distinct actions don't trip it", () => {
		const g = new RepetitionGuard({ window: 5, maxRepeats: 2 });
		assert.equal(g.observe("a").stop, false);
		assert.equal(g.observe("b").stop, false);
		assert.equal(g.observe("c").stop, false);
	});
	it("EVICTS actions older than the window (the sliding-window property, not a raw counter)", () => {
		const g = new RepetitionGuard({ window: 2, maxRepeats: 2 });
		assert.equal(g.observe("X").stop, false);
		assert.equal(g.observe("Y").stop, false);
		// recent=[X,Y,X] → shift → [Y,X]: the first X aged out, only ONE X in window.
		assert.equal(g.observe("X").stop, false, "the first X was evicted >window ago — no trip");
		// recent=[Y,X,X] → shift → [X,X]: two X's now inside the 2-wide window → trips.
		assert.equal(g.observe("X").stop, true, "two X's within the window trip it");
	});
});

describe("evaluateDone — independent verification, not self-assessment", () => {
	it("done only when EVERY verifiable check passes", async () => {
		let testsPass = false;
		const checks: DoneCheck[] = [
			{ name: "typecheck", check: () => true },
			{ name: "tests", check: () => testsPass },
		];
		const a = await evaluateDone(checks);
		assert.equal(a.done, false);
		assert.equal(a.failing, "tests");
		testsPass = true;
		assert.equal((await evaluateDone(checks)).done, true);
	});
	it("a throwing check counts as failed (never crashes the loop)", async () => {
		const r = await evaluateDone([{ name: "flaky", check: () => { throw new Error("boom"); } }]);
		assert.equal(r.done, false);
		assert.equal(r.failing, "flaky");
	});
	it("a rejecting (async) check counts as failed (never crashes the loop)", async () => {
		const r = await evaluateDone([{ name: "asyncFlaky", check: () => Promise.reject(new Error("boom")) }]);
		assert.equal(r.done, false);
		assert.equal(r.failing, "asyncFlaky");
	});
	it("no checks ⇒ never auto-done (rely on budget/no-progress)", async () => {
		assert.equal((await evaluateDone([])).done, false);
	});
});

describe("LoopController — composed guards", () => {
	it("returns the first objective stop reason", () => {
		const c = new LoopController({ budget: { maxIterations: 10 }, noProgressPatience: 2, repetition: { window: 4, maxRepeats: 2 } });
		assert.equal(c.tick({ fingerprint: "s1", action: "act1" }).stop, false);
		assert.equal(c.tick({ fingerprint: "s2", action: "act2" }).stop, false);
		// repeat act2 → repetition trips (maxRepeats 2)
		assert.match(c.tick({ fingerprint: "s3", action: "act2" }).reason ?? "", /repeated/);
	});
	it("no-progress wins over repetition when both would trip on the same iteration", () => {
		// patience 1 and maxRepeats 2: feed the same fingerprint AND action so on the
		// 2nd tick BOTH guards are primed to trip (no-progress stale=1, repetition
		// count=2). tick() checks no-progress first, so its reason must win.
		const c = new LoopController({ budget: { maxIterations: 10 }, noProgressPatience: 1, repetition: { window: 4, maxRepeats: 2 } });
		assert.equal(c.tick({ fingerprint: "same", action: "same" }).stop, false);
		assert.match(c.tick({ fingerprint: "same", action: "same" }).reason ?? "", /no progress/);
	});
	it("budget overrides everything", () => {
		const c = new LoopController({ budget: { maxIterations: 2 } });
		assert.equal(c.tick().stop, false);
		assert.match(c.tick().reason ?? "", /iteration cap/);
	});
});
