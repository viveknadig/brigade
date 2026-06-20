import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runAutonomousLoop } from "./loop-runner.js";

/**
 * Tideline Steps 31/32 — the autonomous-loop runner. Pins: an INDEPENDENT
 * done-check terminates (not the agent's say-so), a budget cap stops a runaway,
 * and the slop gate triggers a bounded repair retry.
 */

describe("loop-runner", () => {
	it("stops when the independent done-check passes", async () => {
		let work = 0;
		const result = await runAutonomousLoop(
			() => {
				work++;
				return { output: `step ${work}`, fingerprint: `fp-${work}` };
			},
			{
				budget: { maxIterations: 50 },
				doneChecks: [{ name: "did-3-units", check: () => work >= 3 }],
				maxRepairs: 0,
			},
		);
		assert.equal(result.done, true);
		assert.equal(result.stopReason, "done");
		assert.equal(result.iterations, 3);
	});

	it("a budget cap stops a runaway loop (never auto-done)", async () => {
		const result = await runAutonomousLoop(
			(ctx) => ({ output: "x", fingerprint: `fp-${ctx.iteration}` }),
			{ budget: { maxIterations: 5 }, maxRepairs: 0 }, // no done-checks ⇒ relies on the cap
		);
		assert.equal(result.done, false);
		assert.equal(result.iterations, 5);
	});

	it("stops on the completion marker (the agent's explicit done signal), bounded by maxIterations", async () => {
		let n = 0;
		const result = await runAutonomousLoop(
			() => {
				n++;
				return { output: n >= 2 ? "all set — TASK_COMPLETE" : `working step ${n}`, fingerprint: `fp-${n}` };
			},
			{ budget: { maxIterations: 50 }, completionMarker: "TASK_COMPLETE", maxRepairs: 0 },
		);
		assert.equal(result.done, true);
		assert.equal(result.stopReason, "completed");
		assert.equal(result.outputs.length, 2, "ran two steps; the second emitted the marker");
		assert.match(result.outputs[1]!, /TASK_COMPLETE/);
	});

	it("a never-emitted marker still stops at maxIterations (marker is an early-out, not the runaway guard)", async () => {
		const result = await runAutonomousLoop(
			(ctx) => ({ output: `still working ${ctx.iteration}`, fingerprint: `fp-${ctx.iteration}` }),
			{ budget: { maxIterations: 4 }, completionMarker: "NEVER_EMITTED", maxRepairs: 0 },
		);
		assert.equal(result.done, false);
		assert.equal(result.iterations, 4, "capped");
	});

	it("a completion GATE can VETO the marker — the run keeps going (budget-bounded) and steers the next turn", async () => {
		const steers: (string | undefined)[] = [];
		const result = await runAutonomousLoop(
			(ctx) => {
				steers.push(ctx.lastSlop);
				return { output: `done — TASK_COMPLETE`, fingerprint: `fp-${ctx.iteration}` }; // claims done every turn
			},
			{
				budget: { maxIterations: 4 },
				completionMarker: "TASK_COMPLETE",
				completionGate: () => ({ accept: false, reason: "high-slop diff" }), // always veto
				maxRepairs: 0,
			},
		);
		assert.equal(result.done, false, "never accepted — the gate vetoed every claim of done");
		assert.equal(result.completionVetoes, 4, "vetoed each turn");
		assert.equal(result.iterations, 4, "still bounded by maxIterations despite the marker");
		assert.ok(steers.slice(1).every((s) => s === "high-slop diff"), "the veto reason steered the subsequent turns");
	});

	it("a completion gate that ACCEPTS lets the marker terminate as 'completed'", async () => {
		const result = await runAutonomousLoop(() => ({ output: "done — TASK_COMPLETE" }), {
			budget: { maxIterations: 5 },
			completionMarker: "TASK_COMPLETE",
			completionGate: () => ({ accept: true }),
			maxRepairs: 0,
		});
		assert.equal(result.done, true);
		assert.equal(result.stopReason, "completed");
		assert.equal(result.completionVetoes, 0);
	});

	it("the slop gate triggers a bounded repair retry", async () => {
		const slop = "At the end of the day, it's important to note that we need to leverage synergy to unlock value moving forward.";
		let calls = 0;
		const result = await runAutonomousLoop(
			(ctx) => {
				calls++;
				// First attempt is slop; the repair pass returns clean text.
				return { output: ctx.repair === 0 ? slop : "Fixed the bug.", fingerprint: "fp" };
			},
			{
				budget: { maxIterations: 1 },
				slopThreshold: 3,
				maxRepairs: 1,
			},
		);
		assert.equal(result.slopRepairs, 1, "one repair fired");
		assert.equal(result.outputs[0], "Fixed the bug.", "the repaired (clean) output was accepted");
		assert.equal(calls, 2, "step ran twice: original + one repair");
	});
});
