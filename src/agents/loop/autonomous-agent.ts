// src/agents/loop/autonomous-agent.ts
//
// Tideline Step 31/32 — the live self-driving autonomous run.
//
// Drives a real agent across MULTIPLE turns toward a task until it's done or a
// guard fires, on top of the `runAutonomousLoop` engine. The done-model is the
// one validated against a mature autonomous agent (see the loop-runner notes):
//   • OBJECTIVE doneChecks (preferred — verifiable: tests pass, file exists), OR
//   • the agent emits a COMPLETION MARKER (the pragmatic terminator for
//     open-ended tasks), bounded by
//   • the guards (max-iterations / no-progress) so a stuck/over-eager agent
//     always stops — never an infinite or self-deluded loop.
//
// `runTurn` is the SEAM: the live caller injects the real turn-runner (it runs
// one Brigade turn and returns the assistant's visible text); tests inject a
// scripted fake, so ALL the control logic here is unit-tested without a model.

import { slopIndex, type SlopFile } from "../quality/slop-index.js";

import type { DoneCheck } from "./loop-guards.js";
import { type AutonomousLoopResult, type CompletionGateResult, runAutonomousLoop } from "./loop-runner.js";

/** Default completion sentinel the agent emits when it considers the task done.
 *  Distinctive + unlikely to appear incidentally in prose. */
export const DEFAULT_COMPLETION_MARKER = "<<BRIGADE_TASK_COMPLETE>>";

/**
 * The autonomous-mode instructions to prepend to the agent's context: keep
 * acting across turns, and emit the marker ONLY when genuinely finished.
 */
export function autonomousModePrompt(marker: string = DEFAULT_COMPLETION_MARKER): string {
	return [
		"You are running AUTONOMOUSLY — you will be re-prompted to CONTINUE until the task is finished or a limit is reached.",
		"Each turn, take a concrete next action toward the task (use tools; don't just describe what you would do).",
		`When — and ONLY when — the task is genuinely complete (and you've verified it, e.g. the change is written / the test passes), emit this exact marker on its own line:`,
		marker,
		"Do not emit the marker while work remains. If you're blocked, say why and what you'd need, then emit the marker (the run will end and report it).",
	].join("\n");
}

export interface AutonomousAgentOpts {
	/** The task to drive to completion. */
	task: string;
	/**
	 * Run ONE agent turn with `prompt`; resolve with the assistant's visible
	 * text. The SEAM — live wiring runs a real Brigade turn here; tests fake it.
	 */
	runTurn: (prompt: string, ctx: { iteration: number; lastSlop?: string }) => Promise<string>;
	/** Hard iteration cap (the runaway guard). Default 25. */
	maxIterations?: number;
	/** Optional wall-clock cap (ms). */
	maxMs?: number;
	/** Completion sentinel (default {@link DEFAULT_COMPLETION_MARKER}). */
	completionMarker?: string;
	/** Objective done-checks (preferred terminator for verifiable goals). */
	doneChecks?: DoneCheck[];
	/** Identical-output repeats before the no-progress guard stops. Default 3. */
	noProgressPatience?: number;
	/** Slop density threshold for the per-turn rewrite gate. */
	slopThreshold?: number;
	/**
	 * CODE Slop-Index completion gate (Step 33). When set, the completion marker is
	 * VETOED if the code the agent produced this run scores too sloppy — so an
	 * autonomous run can't "finish" on a low-quality diff. `getChangedFiles` is the
	 * SEAM: the live caller returns the files the agent changed (e.g. a git diff vs
	 * run-start); tests inject fakes. An empty set scores 0 ⇒ never vetoes, so a
	 * non-code task is unaffected. Default veto threshold 0.6.
	 */
	slopGate?: {
		getChangedFiles: () => SlopFile[] | Promise<SlopFile[]>;
		threshold?: number;
	};
	now?: () => number;
}

const CONTINUE_PROMPT =
	"Continue the task. If it is fully complete and verified, emit the completion marker now; otherwise take the next concrete step.";

/**
 * Run an autonomous agent to completion. Returns the loop result: `done` +
 * `stopReason` ("completed" via marker, "done" via doneChecks, or a guard
 * reason), the per-turn outputs, and how many slop rewrites fired.
 */
export function runAutonomousAgent(opts: AutonomousAgentOpts): Promise<AutonomousLoopResult> {
	const marker = opts.completionMarker ?? DEFAULT_COMPLETION_MARKER;
	// CODE Slop-Index completion gate (Step 33): when the agent claims done, score
	// the diff it produced; veto the marker (keep working) if it's too sloppy. Empty
	// diff ⇒ score 0 ⇒ accept, so non-code tasks pass straight through.
	const slopGate = opts.slopGate;
	const completionGate: ((output: string) => Promise<CompletionGateResult>) | undefined = slopGate
		? async (): Promise<CompletionGateResult> => {
				const files = await slopGate.getChangedFiles();
				if (files.length === 0) return { accept: true };
				const { score, flags } = slopIndex(files);
				const threshold = slopGate.threshold ?? 0.6;
				if (score <= threshold) return { accept: true };
				return {
					accept: false,
					reason: `the code you wrote scores ${(score * 100).toFixed(0)}% on the slop index (${flags.join("; ") || "low quality"}) — clean it up before finishing`,
				};
			}
		: undefined;
	return runAutonomousLoop(
		async (ctx) => {
			const base = ctx.iteration === 0 ? opts.task : CONTINUE_PROMPT;
			const prompt = ctx.lastSlop
				? `${base}\n\n(Your previous reply was flagged as low-quality — ${ctx.lastSlop}. Redo it concretely.)`
				: base;
			const output = await opts.runTurn(prompt, {
				iteration: ctx.iteration,
				...(ctx.lastSlop ? { lastSlop: ctx.lastSlop } : {}),
			});
			return {
				output,
				// No-progress signal: identical visible output across turns ⇒ stuck.
				fingerprint: output.trim().slice(0, 200),
				action: ctx.iteration === 0 ? "task" : "continue",
			};
		},
		{
			budget: {
				maxIterations: opts.maxIterations ?? 25,
				...(opts.maxMs !== undefined ? { maxMs: opts.maxMs } : {}),
			},
			completionMarker: marker,
			noProgressPatience: opts.noProgressPatience ?? 3,
			maxRepairs: 1,
			...(opts.doneChecks ? { doneChecks: opts.doneChecks } : {}),
			...(completionGate ? { completionGate } : {}),
			...(opts.slopThreshold !== undefined ? { slopThreshold: opts.slopThreshold } : {}),
			...(opts.now ? { now: opts.now } : {}),
		},
	);
}
