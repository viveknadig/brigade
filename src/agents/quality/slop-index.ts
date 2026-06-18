// src/agents/quality/slop-index.ts
//
// Tideline Step 33 — the code Slop-Index. The companion to the TEXT slop gate
// (slop-detector.ts): a content-derived score for AI-code sloppiness, used both
// as a quality signal and as a loop-termination criterion (don't "finish" on a
// high-slop diff). Signals computed from content alone — duplication, nesting,
// long functions, TODO density — plus optional caller-supplied churn (revert-
// within-30d) that needs git history. Heuristic by design; a high score flags a
// diff for human review, it doesn't fail a build on its own.

export interface SlopFile {
	path: string;
	content: string;
}

export interface SlopSignals {
	/** Fraction of non-trivial lines that recur (≥2×) across the input. */
	duplicationRatio: number;
	/** Deepest brace/indent nesting seen. */
	maxNestingDepth: number;
	/** Count of functions/blocks longer than the threshold. */
	longBlocks: number;
	/** TODO / FIXME / HACK / XXX markers. */
	todoMarkers: number;
	/** Optional: reverts within 30 days for these files (caller supplies from git). */
	churn?: number;
}

export interface SlopIndexResult {
	/** 0..1, higher = sloppier. */
	score: number;
	signals: SlopSignals;
	flags: string[];
}

const TRIVIAL = /^[\s{}()\[\];,]*$/;

/** Strip string / template / regex-ish bodies + line/block comments so braces
 *  INSIDE them don't inflate the structural signals (nesting, long-blocks).
 *  Coarse — adequate for a heuristic, not a parser. */
function stripLiterals(s: string): string {
	return s
		.replace(/\/\/[^\n]*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function duplicationRatio(lines: string[]): number {
	const counts = new Map<string, number>();
	let nonTrivial = 0;
	for (const raw of lines) {
		const l = raw.trim();
		if (!l || TRIVIAL.test(l) || l.length < 8) continue;
		nonTrivial++;
		counts.set(l, (counts.get(l) ?? 0) + 1);
	}
	if (nonTrivial === 0) return 0;
	let recurringOccurrences = 0;
	for (const n of counts.values()) if (n >= 2) recurringOccurrences += n;
	return recurringOccurrences / nonTrivial;
}

function maxNesting(content: string): number {
	let depth = 0;
	let max = 0;
	for (const ch of stripLiterals(content)) {
		if (ch === "{") {
			depth++;
			if (depth > max) max = depth;
		} else if (ch === "}") {
			depth = Math.max(0, depth - 1);
		}
	}
	return max;
}

function longBlocks(rawLines: string[], threshold: number): number {
	// A "block" = lines between a `{`-opening line and its matching close at the
	// same depth; approximate by counting runs over `threshold` lines at depth ≥1.
	// Operate on a literal-stripped view so braces in strings/comments don't lie.
	const lines = stripLiterals(rawLines.join("\n")).split("\n");
	let depth = 0;
	let runStart = -1;
	let count = 0;
	lines.forEach((line, i) => {
		const opens = (line.match(/{/g) ?? []).length;
		const closes = (line.match(/}/g) ?? []).length;
		if (depth === 0 && opens > closes && runStart === -1) runStart = i;
		depth += opens - closes;
		if (depth <= 0) {
			if (runStart !== -1 && i - runStart > threshold) count++;
			runStart = -1;
			depth = Math.max(0, depth);
		}
	});
	// Flush an unclosed run (a truncated diff hunk would otherwise drop it).
	if (runStart !== -1 && lines.length - 1 - runStart > threshold) count++;
	return count;
}

export function slopIndex(
	files: readonly SlopFile[],
	opts: { longBlockThreshold?: number; churn?: number } = {},
): SlopIndexResult {
	const longThreshold = opts.longBlockThreshold ?? 60;
	// Sanitise caller-supplied churn once: NaN / negative / Infinity would poison
	// the score (NaN) or break the 0..1 contract. Clamp to a non-negative finite.
	const churn = Number.isFinite(opts.churn) ? Math.max(0, opts.churn as number) : 0;
	const allLines: string[] = [];
	let nesting = 0;
	let longs = 0;
	let todos = 0;
	for (const f of files) {
		const lines = f.content.split("\n");
		allLines.push(...lines);
		nesting = Math.max(nesting, maxNesting(f.content));
		longs += longBlocks(lines, longThreshold);
		todos += (f.content.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
	}
	const dupRatio = duplicationRatio(allLines);
	const signals: SlopSignals = {
		duplicationRatio: dupRatio,
		maxNestingDepth: nesting,
		longBlocks: longs,
		todoMarkers: todos,
		...(opts.churn !== undefined ? { churn } : {}),
	};
	const flags: string[] = [];
	if (dupRatio > 0.15) flags.push(`high duplication (${(dupRatio * 100).toFixed(0)}%)`);
	if (nesting > 5) flags.push(`deep nesting (${nesting})`);
	if (longs > 0) flags.push(`${longs} over-long block(s)`);
	if (todos > 3) flags.push(`${todos} TODO/FIXME markers`);
	if (churn > 2) flags.push(`churn (${churn} reverts/30d)`);

	// Weighted blend into 0..1 (each term saturates).
	const score = Math.min(
		1,
		0.4 * Math.min(1, dupRatio / 0.3) +
			0.25 * Math.min(1, Math.max(0, nesting - 4) / 4) +
			0.2 * Math.min(1, longs / 3) +
			0.1 * Math.min(1, todos / 8) +
			0.15 * Math.min(1, churn / 5),
	);
	return { score, signals, flags };
}
