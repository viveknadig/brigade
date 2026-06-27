/**
 * Unit tests for the connect TUI's transcript-projection helpers — the
 * identity key + message-text logic behind reliable rendering (correct
 * placement + idempotent resume). Pure; no Pi-TUI. See `connect-transcript.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asstKey, clipOneLine, extractUserText, joinToolResultText } from "./connect-transcript.js";

test("asstKey: stable per message, distinct per (depth, timestamp)", () => {
	// Same message (same timestamp) → same key: a later update lands on the
	// same block instead of spawning a misplaced copy, and resume re-applies
	// idempotently.
	assert.equal(asstKey(0, { timestamp: 1000 }), "0:1000");
	assert.equal(asstKey(0, { timestamp: 1000 }), asstKey(0, { timestamp: 1000 }));
	// A new message (the post-tool continuation) → a new block.
	assert.notEqual(asstKey(0, { timestamp: 1000 }), asstKey(0, { timestamp: 1001 }));
	// Depth separates sub-agent streams from the top-level stream.
	assert.notEqual(asstKey(0, { timestamp: 1000 }), asstKey(1, { timestamp: 1000 }));
	// Missing timestamp falls back without throwing.
	assert.equal(asstKey(0, {}), "0:live");
	assert.equal(asstKey(2, null), "2:live");
});

test("extractUserText: string content, text-block array, and junk", () => {
	assert.equal(extractUserText({ content: "hi there" }), "hi there");
	assert.equal(
		extractUserText({
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "x" },
				{ type: "text", text: "b" },
			],
		}),
		"ab",
	);
	assert.equal(extractUserText({ content: 42 }), "");
	assert.equal(extractUserText(null), "");
	assert.equal(extractUserText(undefined), "");
});

test("joinToolResultText: joins text blocks, passes strings, ignores non-text", () => {
	assert.equal(joinToolResultText("done"), "done");
	assert.equal(
		joinToolResultText([
			{ type: "text", text: "line1" },
			{ type: "text", text: "line2" },
		]),
		"line1 line2",
	);
	assert.equal(joinToolResultText([{ type: "image", data: "x" }]), "");
	assert.equal(joinToolResultText(undefined), "");
	assert.equal(joinToolResultText(null), "");
});

test("clipOneLine: collapse whitespace, trim, clip with ellipsis", () => {
	assert.equal(clipOneLine("  a\n\n  b  "), "a b");
	assert.equal(clipOneLine(""), "");
	assert.equal(clipOneLine("short", 80), "short");
	const long = "x".repeat(200);
	const clipped = clipOneLine(long);
	assert.equal(clipped.length, 81); // 80 chars + the ellipsis
	assert.ok(clipped.endsWith("…"));
});
