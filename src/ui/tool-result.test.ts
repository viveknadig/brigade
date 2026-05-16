import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { summarizeToolResult } from "./tool-result.js";

describe("summarizeToolResult — success mode", () => {
	it("collapses whitespace to a single line", () => {
		const r = summarizeToolResult("line1\nline2\n\nline3");
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "line1 line2 line3");
	});

	it("truncates at 120 chars with ellipsis", () => {
		const r = summarizeToolResult("x".repeat(200));
		assert.equal(r.preview.length, 120);
		assert.match(r.preview, /…$/);
	});

	it("returns empty when result is null/empty", () => {
		assert.equal(summarizeToolResult(null).hasContent, false);
		assert.equal(summarizeToolResult("   ").hasContent, false);
	});

	it("extracts text from {content: string} (Brigade AgentTool shape)", () => {
		const r = summarizeToolResult({ content: "hello", details: { x: 1 } });
		assert.equal(r.preview, "hello");
	});

	it("extracts text from MCP-style array blocks", () => {
		const r = summarizeToolResult([
			{ type: "text", text: "alpha" },
			{ type: "text", text: "beta" },
		]);
		assert.equal(r.preview, "alpha beta");
	});
});

describe("summarizeToolResult — error mode (preserveNewlines)", () => {
	it("preserves newlines so multi-line block reasons stay readable", () => {
		const blockReason =
			'Tool "bash" was blocked: command "ls" is not on the exec-approvals allowlist. ' +
			"The operator must run\n" +
			'  brigade exec allow "ls"\n' +
			'(or `brigade exec allow-pattern <regex>` for a family of commands) before this command can execute.';
		const r = summarizeToolResult(blockReason, { preserveNewlines: true });
		assert.equal(r.hasContent, true);
		assert.equal(r.multiline, true);
		// The full "brigade exec allow" line MUST be in the output — that's the
		// whole point of error-mode preservation.
		assert.match(r.preview, /brigade exec allow "ls"/);
		// Newlines preserved
		assert.ok(r.preview.includes("\n"));
	});

	it("uses an 800-char budget in error mode (not 120)", () => {
		const longError = "x".repeat(500);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 500);
		assert.equal(r.multiline, false);
	});

	it("truncates at 800 chars when error reason is even longer", () => {
		const longError = "x".repeat(2000);
		const r = summarizeToolResult(longError, { preserveNewlines: true });
		assert.equal(r.preview.length, 800);
		assert.match(r.preview, /…$/);
	});

	it("collapses to single-line when error has no newlines", () => {
		const r = summarizeToolResult("short error", { preserveNewlines: true });
		assert.equal(r.multiline, false);
		assert.equal(r.preview, "short error");
	});

	it("trims outer whitespace but keeps indentation on non-first lines", () => {
		// `replace(/^\s+|\s+$/g, "")` strips leading whitespace through to
		// the first non-whitespace char and trailing whitespace from the
		// last non-whitespace char — that's what we want for block reasons
		// (the call-to-action's indentation on subsequent lines stays).
		const r = summarizeToolResult("\n  intro line\n  brigade exec allow X\n", {
			preserveNewlines: true,
		});
		assert.equal(r.preview, "intro line\n  brigade exec allow X");
		assert.equal(r.multiline, true);
	});
});

describe("summarizeToolResult — opts.maxLength override", () => {
	it("respects an explicit maxLength in success mode", () => {
		const r = summarizeToolResult("a".repeat(50), { maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});

	it("respects an explicit maxLength in error mode", () => {
		const r = summarizeToolResult("a".repeat(50), { preserveNewlines: true, maxLength: 10 });
		assert.equal(r.preview.length, 10);
	});
});
