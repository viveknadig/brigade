import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { autonomousModePrompt, DEFAULT_COMPLETION_MARKER, runAutonomousAgent } from "./autonomous-agent.js";

/**
 * The live self-driving autonomous run. All control logic is tested here via a
 * SCRIPTED `runTurn` fake — no model needed. Pins the done-model:
 * completion marker, objective doneChecks, and the guards as the bound.
 */

describe("runAutonomousAgent", () => {
	it("drives to completion via the marker; first prompt is the task, then 'continue'", async () => {
		const prompts: string[] = [];
		const result = await runAutonomousAgent({
			task: "fix the parser bug",
			runTurn: async (prompt, ctx) => {
				prompts.push(prompt);
				return ctx.iteration >= 2 ? `all fixed ${DEFAULT_COMPLETION_MARKER}` : `working, step ${ctx.iteration}`;
			},
			maxIterations: 10,
		});
		assert.equal(result.done, true);
		assert.equal(result.stopReason, "completed");
		assert.equal(result.outputs.length, 3, "three turns ran");
		assert.equal(prompts[0], "fix the parser bug", "first prompt is the task verbatim");
		assert.match(prompts[1]!, /Continue the task/, "subsequent prompts ask to continue");
	});

	it("an OBJECTIVE doneCheck terminates (preferred path) even without the marker", async () => {
		let built = 0;
		const result = await runAutonomousAgent({
			task: "build the thing",
			runTurn: async () => {
				built++;
				return "still building"; // never emits the marker
			},
			maxIterations: 10,
			noProgressPatience: 100, // identical output — disable no-progress to isolate the doneCheck
			doneChecks: [{ name: "built-twice", check: () => built >= 2 }],
		});
		assert.equal(result.done, true);
		assert.equal(result.stopReason, "done");
	});

	it("a never-finishing run stops at maxIterations (the hard runaway bound)", async () => {
		const result = await runAutonomousAgent({
			task: "loop",
			runTurn: async (_p, ctx) => `unique attempt ${ctx.iteration}`, // unique ⇒ no no-progress; no marker
			maxIterations: 5,
			noProgressPatience: 100,
		});
		assert.equal(result.done, false);
		assert.equal(result.iterations, 5);
	});

	it("a stuck agent (repeating output) trips the no-progress guard BEFORE maxIterations", async () => {
		const result = await runAutonomousAgent({
			task: "stuck",
			runTurn: async () => "the exact same reply each time",
			maxIterations: 100,
			noProgressPatience: 3,
		});
		assert.equal(result.done, false);
		assert.ok(result.iterations < 100, `stopped early via no-progress (ran ${result.iterations})`);
	});

	it("autonomousModePrompt embeds the marker + the continue/verify contract", () => {
		const p = autonomousModePrompt();
		assert.match(p, /AUTONOMOUSLY/);
		assert.ok(p.includes(DEFAULT_COMPLETION_MARKER));
	});
});

describe("runAutonomousAgent — code Slop-Index completion gate (Step 33)", () => {
	it("VETOES the marker on a high-slop diff, then accepts once the agent cleans it up", async () => {
		const sloppy = Array.from({ length: 12 }, () => "const x = computeThing(a, b, c);").join("\n"); // heavy duplication
		const clean = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
		let cleanedUp = false;
		const result = await runAutonomousAgent({
			task: "write some code",
			maxIterations: 6,
			runTurn: async (_p, ctx) => {
				if (ctx.iteration >= 2) cleanedUp = true; // after a couple of vetoes, fix it
				return `done ${DEFAULT_COMPLETION_MARKER}`; // always claims done
			},
			slopGate: {
				threshold: 0.1,
				getChangedFiles: () => [{ path: "x.ts", content: cleanedUp ? clean : sloppy }],
			},
		});
		assert.ok(result.completionVetoes >= 1, "the sloppy diff was vetoed at least once");
		assert.equal(result.done, true, "accepted once the diff was cleaned up");
		assert.equal(result.stopReason, "completed");
	});

	it("an empty diff (a non-code task) never vetoes — the gate is a no-op", async () => {
		const result = await runAutonomousAgent({
			task: "answer a question",
			maxIterations: 3,
			runTurn: async () => `done ${DEFAULT_COMPLETION_MARKER}`,
			slopGate: { getChangedFiles: () => [] },
		});
		assert.equal(result.done, true);
		assert.equal(result.completionVetoes, 0, "no code changed ⇒ score 0 ⇒ never vetoed");
		assert.equal(result.stopReason, "completed");
	});
});
