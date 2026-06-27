/**
 * Unit tests for the reliable-streaming sequence helpers — the gap-detection
 * contract shared by the gateway (stamps seq) and the client (detects gaps).
 * Pure; no socket. See `stream-seq.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isSeqGap, nextSeq } from "./stream-seq.js";

test("nextSeq increments per-session", () => {
	const c = new Map<string, number>();
	assert.equal(nextSeq(c, "s1"), 1);
	assert.equal(nextSeq(c, "s1"), 2);
	assert.equal(nextSeq(c, "s1"), 3);
	// A different session keeps its OWN monotonic counter.
	assert.equal(nextSeq(c, "s2"), 1);
	assert.equal(nextSeq(c, "s1"), 4);
});

test("nextSeq returns undefined for an untagged frame (no session, no counter touch)", () => {
	const c = new Map<string, number>();
	assert.equal(nextSeq(c, undefined), undefined);
	// The undefined call did not advance any counter.
	assert.equal(nextSeq(c, "s1"), 1);
});

test("isSeqGap: first frame and contiguous successor are NOT gaps", () => {
	assert.equal(isSeqGap(undefined, 1), false); // first frame for the session
	assert.equal(isSeqGap(1, 2), false);
	assert.equal(isSeqGap(41, 42), false);
});

test("isSeqGap: a jump up is a gap (a frame was missed)", () => {
	assert.equal(isSeqGap(1, 3), true);
	assert.equal(isSeqGap(10, 25), true);
});

test("isSeqGap: a lower or equal seq is a gap (gateway restart reset / duplicate)", () => {
	assert.equal(isSeqGap(50, 1), true); // counters reset on restart
	assert.equal(isSeqGap(5, 5), true); // duplicate — resume is idempotent, so safe
});
