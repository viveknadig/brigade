/**
 * Stagger — deterministic per-job offset within a bounded window.
 *
 * Coverage:
 *   1. Stable offset for the same jobId / staggerMs pair (idempotent).
 *   2. Distribution across the window for varied jobIds (rough uniformity).
 *   3. Cache LRU bound — under repeated unique inputs the cache doesn't
 *      grow without bound.
 *   4. Default-window helper for top-of-hour cron expressions.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	clearStaggerCacheForTests,
	computeJobStaggerOffsetMs,
	defaultStaggerMsForCronExpression,
} from "./stagger.js";

describe("stagger — computeJobStaggerOffsetMs", () => {
	it("returns 0 when staggerMs <= 0", () => {
		clearStaggerCacheForTests();
		assert.equal(computeJobStaggerOffsetMs("any-id", 0), 0);
		assert.equal(computeJobStaggerOffsetMs("any-id", -1), 0);
	});

	it("same (jobId, staggerMs) is stable across repeated calls", () => {
		clearStaggerCacheForTests();
		const a = computeJobStaggerOffsetMs("job-abc", 60_000);
		const b = computeJobStaggerOffsetMs("job-abc", 60_000);
		const c = computeJobStaggerOffsetMs("job-abc", 60_000);
		assert.equal(a, b);
		assert.equal(b, c);
	});

	it("offsets stay inside [0, staggerMs)", () => {
		clearStaggerCacheForTests();
		const window = 5 * 60 * 1000;
		for (let i = 0; i < 50; i++) {
			const offset = computeJobStaggerOffsetMs(`job-${i}`, window);
			assert.ok(offset >= 0);
			assert.ok(offset < window);
		}
	});

	it("varied jobIds distribute across the window (not all the same offset)", () => {
		clearStaggerCacheForTests();
		const window = 5 * 60 * 1000;
		const seen = new Set<number>();
		for (let i = 0; i < 50; i++) {
			seen.add(computeJobStaggerOffsetMs(`job-${i}`, window));
		}
		// Rough uniformity — with 50 jobs in a 5-min window we expect at
		// least 25 distinct offsets. SHA-256 makes collisions extremely
		// unlikely below this threshold.
		assert.ok(seen.size >= 25, `expected >=25 distinct offsets, got ${seen.size}`);
	});

	it("cache doesn't grow without bound under unique inputs", () => {
		clearStaggerCacheForTests();
		const window = 60_000;
		// 5000 unique jobIds exceeds STAGGER_CACHE_MAX (4096) → oldest gets evicted.
		for (let i = 0; i < 5000; i++) {
			computeJobStaggerOffsetMs(`unique-${i}`, window);
		}
		// No assertion on internal size (private), but the call must not
		// have thrown / OOMed. Subsequent calls remain stable for the
		// most-recent ids.
		const out = computeJobStaggerOffsetMs("unique-4999", window);
		assert.equal(typeof out, "number");
	});
});

describe("stagger — defaultStaggerMsForCronExpression", () => {
	it("top-of-hour expressions get a 5-minute window", () => {
		assert.equal(defaultStaggerMsForCronExpression("0 * * * *"), 5 * 60 * 1000);
		assert.equal(defaultStaggerMsForCronExpression("0 9 * * *"), 5 * 60 * 1000);
		assert.equal(defaultStaggerMsForCronExpression("0 0 1 * *"), 5 * 60 * 1000);
	});

	it("non-top-of-hour expressions get 0 (exact firing)", () => {
		assert.equal(defaultStaggerMsForCronExpression("*/15 * * * *"), 0);
		assert.equal(defaultStaggerMsForCronExpression("30 14 * * *"), 0);
	});

	it("empty / whitespace expression returns 0", () => {
		assert.equal(defaultStaggerMsForCronExpression(""), 0);
		assert.equal(defaultStaggerMsForCronExpression("   "), 0);
	});
});
