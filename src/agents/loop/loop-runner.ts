// src/agents/loop/loop-runner.ts
//
// Tideline Steps 31/32 — the autonomous-loop orchestration primitive.
//
// Drives a `step` function under the loop guards: each iteration runs the step,
// gates its output through the TEXT slop detector with a BOUNDED repair retry
// (the post-generation hook), ticks the LoopController (budget / no-progress /
// repetition), and stops only when evaluateDone's INDEPENDENT checks pass OR a
// guard fires — never on the agent's own say-so. This is the harness Step 31
// wires into agent-loop.ts (slop-gate as a post-generation hook; the controller
// driving an autonomous run); built standalone so the control logic is testable
// without a live gateway. The `step` callback IS the agent turn (or a planner/
// executor stage for the Plan-and-Execute shape of Step 32).

import { detectSlop, summarizeSlop } from "../quality/slop-detector.js";
import { type DoneCheck, evaluateDone, LoopController, type StopDecision } from "./loop-guards.js";

export interface LoopStepResult {
	output: string;
	/** State hash for the no-progress guard. */
	fingerprint?: string;
	/** Action label for the repetition guard. */
	action?: string;
	/** Tokens spent this step (for the budget). */
	tokens?: number;
}

export interface AutonomousLoopOpts {
	budget: { maxIterations?: number; maxMs?: number; maxTokens?: number };
	noProgressPatience?: number;
	repetition?: { window: number; maxRepeats: number };
	/** INDEPENDENT termination checks — done only when ALL pass. The PREFERRED
	 *  terminator when the task has a verifiable goal (tests pass, file exists, a
	 *  tool succeeded) — objective signals, not the agent's self-assessment. */
	doneChecks?: DoneCheck[];
	/** Completion sentinel — when a step's output CONTAINS this string, the agent
	 *  has signalled the task is done (the common autonomous-agent "emit a
	 *  FINAL-OUTPUT marker when finished" pattern). The pragmatic terminator for
	 *  open-ended tasks with no objective check; still bounded by the budget caps
	 *  below (the marker is an early-out, NOT a runaway guard — a misbehaving
	 *  agent that never emits it still stops at maxIterations). */
	completionMarker?: string;
	/** Optional QUALITY gate run when the completion marker is seen: returns whether
	 *  to ACCEPT the completion. A veto (accept:false) rejects the marker for this
	 *  turn — the loop keeps going (still budget-bounded), feeding `reason` back as
	 *  a steer — so the agent can't "finish" on a low-quality artifact (e.g. a
	 *  high-slop code diff, the Step-33 code Slop-Index). Only consulted alongside
	 *  completionMarker. */
	completionGate?: (output: string) => Promise<CompletionGateResult> | CompletionGateResult;
	/** Slop density threshold for the post-generation gate (default detectSlop's). */
	slopThreshold?: number;
	/** Bounded slop-repair retries per step (default 1). */
	maxRepairs?: number;
	now?: () => number;
}

export interface CompletionGateResult {
	/** Accept the completion marker (terminate) or veto it (keep working). */
	accept: boolean;
	/** When vetoing, a short reason fed back to the next turn as a steer. */
	reason?: string;
}

export interface AutonomousLoopResult {
	iterations: number;
	stopReason: string;
	done: boolean;
	outputs: string[];
	slopRepairs: number;
	/** Times the completion marker was REJECTED by the completion gate. */
	completionVetoes: number;
}

/**
 * Run an autonomous loop. `step` is invoked once per iteration; when its output
 * trips the slop gate it is re-run up to `maxRepairs` times (with the slop
 * summary as a hint) before being accepted. Terminates on the FIRST of: an
 * independent done-check passing, or a guard (budget / no-progress / repetition).
 */
export async function runAutonomousLoop(
	step: (ctx: { iteration: number; repair: number; lastSlop?: string }) => Promise<LoopStepResult> | LoopStepResult,
	opts: AutonomousLoopOpts,
): Promise<AutonomousLoopResult> {
	const controller = new LoopController(
		{
			budget: opts.budget,
			...(opts.noProgressPatience !== undefined ? { noProgressPatience: opts.noProgressPatience } : {}),
			...(opts.repetition ? { repetition: opts.repetition } : {}),
		},
		opts.now,
	);
	const maxRepairs = opts.maxRepairs ?? 1;
	if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
		throw new Error(`runAutonomousLoop: maxRepairs must be a non-negative integer (got ${opts.maxRepairs})`);
	}
	// A runaway-prevention primitive must not itself be able to run forever: refuse
	// to start without at least one terminating condition.
	const b = opts.budget;
	const hasBudgetCap = b.maxIterations !== undefined || b.maxMs !== undefined || b.maxTokens !== undefined;
	const hasDoneCheck = !!opts.doneChecks && opts.doneChecks.length > 0;
	if (!hasBudgetCap && !hasDoneCheck) {
		throw new Error(
			"runAutonomousLoop needs a terminating condition: set a budget cap (maxIterations / maxMs / maxTokens) and/or doneChecks",
		);
	}
	const slopOpts = opts.slopThreshold !== undefined ? { threshold: opts.slopThreshold } : {};
	const outputs: string[] = [];
	let slopRepairs = 0;
	let completionVetoes = 0;
	let stopReason = "budget";
	let done = false;
	// A gate-veto steer carried from the PREVIOUS iteration into the next turn's
	// prompt (reuses the slop-repair `lastSlop` channel — same "fix it, then go on"
	// semantics). Consumed once at the top of the loop.
	let pendingSteer: string | undefined;

	for (;;) {
		// Post-generation slop gate with bounded repair. Tokens from EVERY step
		// invocation (initial + each repair) accumulate so repair attempts can't
		// bypass the token budget.
		const startSteer = pendingSteer;
		pendingSteer = undefined;
		let result = await step({ iteration: controller.iterations, repair: 0, ...(startSteer ? { lastSlop: startSteer } : {}) });
		let totalTokens = result.tokens ?? 0;
		let repair = 0;
		let lastSlop: string | undefined;
		while (repair < maxRepairs) {
			const verdict = detectSlop(result.output, slopOpts);
			if (!verdict.isSlop) break;
			lastSlop = summarizeSlop(verdict);
			repair++;
			slopRepairs++;
			result = await step({ iteration: controller.iterations, repair, ...(lastSlop ? { lastSlop } : {}) });
			totalTokens += result.tokens ?? 0;
		}
		outputs.push(result.output);

		// Completion marker — the agent's explicit "task done" signal (an early-out
		// before the guards). Objective doneChecks below still take precedence when
		// configured; this is the terminator for open-ended tasks that have none.
		// An optional completion GATE can VETO the marker (e.g. a high-slop diff):
		// the run then keeps going (still budget-bounded) with the reason steered in.
		if (opts.completionMarker && result.output.includes(opts.completionMarker)) {
			const gate = opts.completionGate ? await opts.completionGate(result.output) : { accept: true };
			if (gate.accept) {
				done = true;
				stopReason = "completed";
				break;
			}
			completionVetoes++;
			pendingSteer = gate.reason ?? "the result did not pass the completion quality gate — improve it before finishing";
		}

		const decision: StopDecision = controller.tick({
			...(result.fingerprint !== undefined ? { fingerprint: result.fingerprint } : {}),
			...(result.action !== undefined ? { action: result.action } : {}),
			tokens: totalTokens,
		});
		if (decision.stop) {
			// A non-budget (no-progress/repetition) guard must not MASK a genuinely
			// completed turn: if the independent checks pass, report "done".
			if (hasDoneCheck && (await evaluateDone(opts.doneChecks!)).done) {
				done = true;
				stopReason = "done";
			} else {
				stopReason = decision.reason ?? "guard";
			}
			break;
		}

		if (opts.doneChecks && opts.doneChecks.length > 0) {
			const d = await evaluateDone(opts.doneChecks);
			if (d.done) {
				done = true;
				stopReason = "done";
				break;
			}
		}
	}
	return { iterations: controller.iterations, stopReason, done, outputs, slopRepairs, completionVetoes };
}
