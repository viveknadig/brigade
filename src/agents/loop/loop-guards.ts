/**
 * Loop-engineering guards — deterministic safety rails for autonomous, long-
 * horizon agent loops. The principle (project-wide): an autonomous loop stops on
 * OBJECTIVE signals — a budget hit, no progress, repetition, or a VERIFIABLE
 * done-check — NEVER the agent's own "I'm done". Generic + injectable so the live
 * agent loop wires them without each guard knowing Brigade internals.
 *
 * Composed by {@link LoopController}: call `tick()` once per iteration with the
 * observed state; it returns the first stop reason or `{ stop: false }`.
 */

export interface StopDecision {
	stop: boolean;
	reason?: string;
}
const GO: StopDecision = { stop: false };

/** Hard caps — the non-negotiable floor (iterations · tokens · wall-time). */
export class LoopBudget {
	private iters = 0;
	private tokens = 0;
	private readonly start: number;
	constructor(
		private readonly limits: { maxIterations?: number; maxMs?: number; maxTokens?: number },
		private readonly now: () => number = () => Date.now(),
	) {
		const { maxIterations, maxMs, maxTokens } = limits;
		if (maxIterations !== undefined && maxIterations < 1) {
			throw new Error(`LoopBudget: maxIterations (${maxIterations}) must be >= 1`);
		}
		if (maxMs !== undefined && maxMs < 1) {
			throw new Error(`LoopBudget: maxMs (${maxMs}) must be >= 1`);
		}
		if (maxTokens !== undefined && maxTokens < 1) {
			throw new Error(`LoopBudget: maxTokens (${maxTokens}) must be >= 1`);
		}
		this.start = now();
	}
	/** Record one iteration (+ optional tokens spent this iteration). */
	tick(tokensDelta = 0): void {
		this.iters += 1;
		this.tokens += Number.isFinite(tokensDelta) ? Math.max(0, tokensDelta) : 0;
	}
	get iterations(): number {
		return this.iters;
	}
	get tokensSpent(): number {
		return this.tokens;
	}
	exceeded(): StopDecision {
		const { maxIterations, maxMs, maxTokens } = this.limits;
		if (maxIterations !== undefined && this.iters >= maxIterations) {
			return { stop: true, reason: `iteration cap (${maxIterations}) reached` };
		}
		if (maxTokens !== undefined && this.tokens >= maxTokens) {
			return { stop: true, reason: `token budget (${maxTokens}) reached` };
		}
		if (maxMs !== undefined && this.now() - this.start >= maxMs) {
			return { stop: true, reason: `time budget (${maxMs}ms) reached` };
		}
		return GO;
	}
}

/** No-progress: stop if the state fingerprint is unchanged for `patience`
 *  consecutive iterations (catches silent failures — tool calls happen but
 *  nothing changes). */
export class NoProgressGuard {
	private last: string | undefined;
	private stale = 0;
	constructor(private readonly patience: number) {
		if (patience < 1) {
			throw new Error(`NoProgressGuard: patience (${patience}) must be >= 1`);
		}
	}
	observe(fingerprint: string): StopDecision {
		if (fingerprint === this.last) {
			this.stale += 1;
			if (this.stale >= this.patience) {
				return { stop: true, reason: `no progress for ${this.patience} iterations` };
			}
		} else {
			this.last = fingerprint;
			this.stale = 0;
		}
		return GO;
	}
}

/** Repetition: stop if the same action fingerprint recurs `maxRepeats` times
 *  within the last `window` actions (catches "called a broken tool 400×"). */
export class RepetitionGuard {
	private readonly recent: string[] = [];
	constructor(private readonly opts: { window: number; maxRepeats: number }) {
		if (opts.window < 1) {
			throw new Error(`RepetitionGuard: window (${opts.window}) must be >= 1`);
		}
		if (opts.maxRepeats < 1) {
			throw new Error(`RepetitionGuard: maxRepeats (${opts.maxRepeats}) must be >= 1`);
		}
		if (opts.maxRepeats > opts.window) {
			throw new Error(`RepetitionGuard: maxRepeats (${opts.maxRepeats}) cannot exceed window (${opts.window}) — the guard would never trip`);
		}
	}
	observe(actionFingerprint: string): StopDecision {
		this.recent.push(actionFingerprint);
		if (this.recent.length > this.opts.window) this.recent.shift();
		const count = this.recent.filter((a) => a === actionFingerprint).length;
		if (count >= this.opts.maxRepeats) {
			return { stop: true, reason: `action repeated ${count}× in the last ${this.recent.length}` };
		}
		return GO;
	}
}

/** A verifiable done-check (tests pass, typecheck clean, file exists …). */
export type DoneCheck = { name: string; check: () => boolean | Promise<boolean> };

/**
 * INDEPENDENT termination — the loop is done ONLY when EVERY verifiable check
 * passes (objective signals, not the agent's self-assessment). Returns the first
 * failing check so the loop knows what's left. `[]` ⇒ never auto-done (the loop
 * relies on budget/no-progress instead).
 */
export async function evaluateDone(checks: readonly DoneCheck[]): Promise<{ done: boolean; failing?: string }> {
	for (const c of checks) {
		let ok = false;
		try {
			ok = await c.check();
		} catch {
			ok = false;
		}
		if (!ok) return { done: false, failing: c.name };
	}
	return { done: checks.length > 0 };
}

/** Composes the guards. One `tick()` per loop iteration → the first stop reason. */
export class LoopController {
	private readonly budget: LoopBudget;
	private readonly noProgress?: NoProgressGuard;
	private readonly repetition?: RepetitionGuard;
	constructor(
		opts: {
			budget: { maxIterations?: number; maxMs?: number; maxTokens?: number };
			noProgressPatience?: number;
			repetition?: { window: number; maxRepeats: number };
		},
		now: () => number = () => Date.now(),
	) {
		this.budget = new LoopBudget(opts.budget, now);
		if (opts.noProgressPatience !== undefined) this.noProgress = new NoProgressGuard(opts.noProgressPatience);
		if (opts.repetition !== undefined) this.repetition = new RepetitionGuard(opts.repetition);
	}
	/** Call once per iteration. `fingerprint` = state hash (for no-progress);
	 *  `action` = the action taken (for repetition); `tokens` = tokens spent. */
	tick(obs: { fingerprint?: string; action?: string; tokens?: number } = {}): StopDecision {
		this.budget.tick(obs.tokens ?? 0);
		const overBudget = this.budget.exceeded();
		if (overBudget.stop) return overBudget;
		if (obs.fingerprint !== undefined && this.noProgress) {
			const np = this.noProgress.observe(obs.fingerprint);
			if (np.stop) return np;
		}
		if (obs.action !== undefined && this.repetition) {
			const rep = this.repetition.observe(obs.action);
			if (rep.stop) return rep;
		}
		return GO;
	}
	get iterations(): number {
		return this.budget.iterations;
	}
}
