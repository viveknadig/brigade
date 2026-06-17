/**
 * AI-slop detector — the deterministic, code-side layer of a two-layer slop gate.
 *
 * Prompt guidance stops ~80% of slop; this catches the critical 20% that ships
 * to users. It scans text in FOUR passes (vocabulary crutches, cliché phrases,
 * formulaic openers, regex structures) and returns a verdict + the hits, so the
 * caller can trigger ONE bounded repair retry. Zero-dep, no model — an OBJECTIVE
 * check (the anti-slop arm of the project-wide principle "independent
 * verification, never the agent judging itself").
 *
 * It flags DENSITY, not single words: one "robust" in a technical answer is
 * fine; three crutches + a formulaic opener is slop. The default threshold (3
 * distinct hits) is tunable per surface.
 */

/** Pass 1 — single-word LLM "tells" (vocabulary crutches). Curated, not
 *  exhaustive; these co-occur in machine-default prose far above human baseline. */
const SLOP_VOCAB = new Set<string>([
	"delve", "tapestry", "robust", "crucially", "leverage", "leveraging", "utilize", "utilizing",
	"seamless", "seamlessly", "elevate", "realm", "landscape", "navigate", "navigating", "foster",
	"underscore", "underscores", "testament", "pivotal", "intricate", "multifaceted", "nuanced",
	"holistic", "paradigm", "synergy", "myriad", "plethora", "vibrant", "bustling", "embark",
	"unlock", "unlocking", "harness", "harnessing", "cutting-edge", "groundbreaking", "moreover",
	"furthermore", "notably", "arguably", "essentially", "fundamentally", "meticulous", "meticulously",
]);

/** Pass 2 — cliché multi-word phrases (substring match, case-insensitive). */
const SLOP_PHRASES: readonly string[] = [
	"it's important to note", "it is important to note", "it's worth noting", "it is worth noting",
	"when it comes to", "at the end of the day", "a testament to", "plays a crucial role",
	"plays a vital role", "in today's fast-paced", "ever-evolving", "ever-changing", "rich tapestry",
	"the world of", "stands as a", "in the realm of", "navigating the", "a deep dive", "deep dive into",
	"game-changer", "game changer", "best practices", "look no further", "rest assured", "needless to say",
];

/** Pass 3 — formulaic openers (checked at the start of the text + each paragraph). */
const SLOP_OPENERS: readonly string[] = [
	"in today's", "in the world of", "in the realm of", "in an era", "in a world",
	"when it comes to", "let's dive in", "let's explore", "imagine a world", "picture this",
	"in conclusion", "in summary", "to sum up", "first and foremost",
];

/** Pass 4 — formulaic sentence STRUCTURES (regex). */
const SLOP_REGEX: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "not-only-but-also", re: /\bnot only\b[^.?!]{1,60}\bbut also\b/i },
	{ id: "its-not-just-its", re: /\bit'?s not just\b[^.?!]{1,60}\bit'?s\b/i },
	{ id: "whether-or", re: /\bwhether you'?re\b[^.?!]{1,50}\bor\b/i },
	{ id: "more-than-its", re: /\bis more than just\b/i },
	{ id: "in-conclusion", re: /\bin conclusion\b/i },
	{ id: "rule-of-three-adj", re: /\b(\w+),\s+(\w+),\s+and\s+(\w+)\b/i }, // disabled below — kept as documentation
];

export type SlopPass = "vocabulary" | "phrase" | "opener" | "structure";
export interface SlopHit {
	pass: SlopPass;
	match: string;
}
export interface SlopVerdict {
	isSlop: boolean;
	/** Total distinct hits across passes (the density score). */
	score: number;
	hits: SlopHit[];
	/** Hits per 100 words (length-normalised). */
	density: number;
}

const DEFAULT_THRESHOLD = 3;

/**
 * Scan `text` for slop in four passes (vocabulary, phrase, opener, structure)
 * and score it by the count of DISTINCT matched strings across all passes — a
 * match that appears in two pass lists is one offense, not two. `isSlop` when
 * `score >= threshold` (default 3). The rule-of-three regex is skipped entirely
 * (too noisy: never run, never surfaced).
 */
export function detectSlop(text: string, opts: { threshold?: number } = {}): SlopVerdict {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	const hits: SlopHit[] = [];

	// Pass 1 — vocabulary (each distinct crutch counts once).
	const seenVocab = new Set<string>();
	for (const tok of lower.split(/[^a-z-]+/)) {
		if (tok && SLOP_VOCAB.has(tok) && !seenVocab.has(tok)) {
			seenVocab.add(tok);
			hits.push({ pass: "vocabulary", match: tok });
		}
	}

	// Pass 2 — phrases.
	for (const p of SLOP_PHRASES) {
		if (lower.includes(p)) hits.push({ pass: "phrase", match: p });
	}

	// Pass 3 — openers (text start + each paragraph start).
	const starts = lower.split(/\n+/).map((para) => para.trimStart().replace(/^([-*+>#]\s+|\d+\.\s+)+/, ""));
	for (const start of starts) {
		for (const o of SLOP_OPENERS) {
			if (start.startsWith(o)) {
				hits.push({ pass: "opener", match: o });
				break; // one opener hit per paragraph
			}
		}
	}

	// Pass 4 — structures. The `in-conclusion` regex catches mid-text occurrences
	// the opener (paragraph-start only) misses; surface it under the SAME match
	// text as the opener so the two never DOUBLE-count the same phrase below.
	for (const { id, re } of SLOP_REGEX) {
		if (id === "rule-of-three-adj") continue; // too noisy to count toward score
		if (re.test(text)) hits.push({ pass: "structure", match: id === "in-conclusion" ? "in conclusion" : id });
	}

	// Distinct matched strings only — a phrase that lives in two pass lists
	// (e.g. "when it comes to" as both phrase AND opener) is ONE offense, not two.
	const score = new Set(hits.map((h) => h.match.toLowerCase())).size;
	const density = words.length > 0 ? (score / words.length) * 100 : 0;
	return { isSlop: score >= threshold, score, hits, density };
}

/** A one-line summary of why something was flagged (for logs / repair prompts). */
export function summarizeSlop(v: SlopVerdict): string {
	if (!v.isSlop) return "no slop";
	const byPass = new Map<SlopPass, string[]>();
	for (const h of v.hits) byPass.set(h.pass, [...(byPass.get(h.pass) ?? []), h.match]);
	return [...byPass.entries()].map(([pass, ms]) => `${pass}: ${ms.slice(0, 4).join(", ")}`).join(" · ");
}
