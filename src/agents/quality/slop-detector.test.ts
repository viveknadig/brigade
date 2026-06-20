import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { detectSlop, summarizeSlop } from "./slop-detector.js";

/**
 * The text-slop gate (code-side validator) — the deterministic 20% that prompt
 * guidance misses. Flags DENSITY of machine-default tells, not single words.
 */

describe("slop detector", () => {
	it("clean technical prose is NOT slop", () => {
		const text =
			"The function returns the user record. It throws if the id is missing. " +
			"Run `npm test` to verify, then commit. The retry uses exponential backoff.";
		const v = detectSlop(text);
		assert.equal(v.isSlop, false, `expected clean, got ${summarizeSlop(v)}`);
		assert.ok(v.score < 3);
	});

	it("a SINGLE crutch is below threshold (no false positive)", () => {
		const v = detectSlop("Use a robust retry policy here.");
		assert.equal(v.isSlop, false);
		assert.equal(v.score, 1);
	});

	it("slop-laden prose is flagged, with hits across all four passes", () => {
		const text =
			"In today's fast-paced landscape, it's important to note that we must delve into " +
			"robust, cutting-edge solutions. Leverage seamless synergy to unlock a holistic " +
			"paradigm — not only streamlining output but also building a rich tapestry of value.";
		const v = detectSlop(text);
		assert.equal(v.isSlop, true);
		assert.ok(v.score >= 3);
		const passes = new Set(v.hits.map((h) => h.pass));
		assert.ok(passes.has("vocabulary"), "vocabulary pass fired");
		assert.ok(passes.has("phrase"), "phrase pass fired");
		assert.ok(passes.has("opener"), "opener pass fired");
		assert.ok(passes.has("structure"), "structure pass fired (not only…but also)");
	});

	it("a benign rule-of-three sentence with no other tells is NOT slop", () => {
		// The rule-of-three regex is disabled (kept only as documentation), so a
		// plain "X, Y, and Z" sentence with no vocab/phrase/opener tells scores 0.
		const v = detectSlop("The cat, the dog, and the fish sat quietly.");
		assert.equal(v.isSlop, false);
		assert.equal(v.score, 0);
	});

	it("a paragraph starting with a markdown list marker still fires the opener pass", () => {
		const v = detectSlop("- In conclusion, we leverage robust seamless synergy.");
		const passes = new Set(v.hits.map((h) => h.pass));
		assert.ok(passes.has("opener"), "opener pass fired past the list marker");
		assert.ok(v.hits.some((h) => h.pass === "opener" && h.match === "in conclusion"));
	});

	it("threshold is tunable per surface", () => {
		const text = "We leverage robust synergy."; // 3 vocab hits
		assert.equal(detectSlop(text, { threshold: 3 }).isSlop, true);
		assert.equal(detectSlop(text, { threshold: 5 }).isSlop, false);
	});

	it("reports density (hits per 100 words) for length-aware gating", () => {
		const v = detectSlop("delve tapestry robust");
		assert.equal(v.score, 3);
		assert.equal(v.density, 100); // 3 distinct hits / 3 words * 100
		// Same 3 hits diluted across 6 words halves the per-100-word density.
		const padded = detectSlop("delve tapestry robust one two three");
		assert.equal(padded.score, 3);
		assert.equal(padded.density, 50);
	});

	it("summarizeSlop groups the hits by pass", () => {
		const v = detectSlop("In conclusion, we leverage robust, seamless synergy.");
		assert.match(summarizeSlop(v), /vocabulary:/);
		// "in conclusion" fires as BOTH opener and structure, but the score
		// dedups same-string matches — counted once, not twice.
		const conclusionHits = v.hits.filter((h) => h.match === "in conclusion");
		assert.equal(conclusionHits.length, 2, "surfaced under both opener and structure");
		assert.deepEqual(new Set(conclusionHits.map((h) => h.pass)), new Set(["opener", "structure"]));
		// 4 vocab (leverage, robust, seamless, synergy) + 1 distinct "in conclusion" = 5.
		assert.equal(v.score, 5);
	});
});
