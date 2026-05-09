import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { sanitizeMessages, sanitizeSurrogates } from "./sanitize-surrogates.js";

describe("sanitizeSurrogates", () => {
	it("returns input unchanged for empty / null", () => {
		assert.equal(sanitizeSurrogates(""), "");
		assert.equal(sanitizeSurrogates(null as unknown as string), null);
	});

	it("preserves clean ASCII text", () => {
		assert.equal(sanitizeSurrogates("hello world"), "hello world");
	});

	it("preserves valid surrogate pairs (emoji, 4-byte UTF-8)", () => {
		// 🚀 = U+1F680, encoded as surrogate pair D83D DE80
		const rocket = "🚀";
		assert.equal(sanitizeSurrogates(rocket), rocket);
		// 👋 = U+1F44B, encoded as surrogate pair D83D DC4B
		assert.equal(sanitizeSurrogates("Hi 👋!"), "Hi 👋!");
	});

	it("strips a lone HIGH surrogate (no following low)", () => {
		const broken = `before\uD83Dafter`;
		assert.equal(sanitizeSurrogates(broken), "beforeafter");
	});

	it("strips a lone LOW surrogate (no preceding high)", () => {
		const broken = `before\uDC4Bafter`;
		assert.equal(sanitizeSurrogates(broken), "beforeafter");
	});

	it("strips multiple lone halves while preserving valid pairs", () => {
		// Valid 🚀 (D83D + DE80) + lone high (D83D, no follow) + valid 👋 (D83D + DC4B)
		// + lone low (DC4B, no preceding high) → expect both lone halves stripped,
		// both valid pairs survive.
		const mixed = `🚀\uD83Dx👋\uDC4By`;
		// strip pass 1 (lone high not followed by low): the standalone D83D before "x" goes
		// strip pass 2 (lone low not preceded by high): the trailing DC4B goes
		assert.equal(sanitizeSurrogates(mixed), `🚀x👋y`);
	});

	it("preserves non-BMP text that doesn't use surrogates (e.g., CJK)", () => {
		assert.equal(sanitizeSurrogates("こんにちは"), "こんにちは");
		assert.equal(sanitizeSurrogates("中文"), "中文");
	});
});

describe("sanitizeMessages", () => {
	it("returns input unchanged for empty array", () => {
		assert.deepEqual(sanitizeMessages([]), []);
	});

	it("returns input as-is for non-array input", () => {
		// @ts-expect-error - testing defensive path
		const result = sanitizeMessages(null);
		assert.equal(result, null);
	});

	it("strips lone surrogates from text content blocks", () => {
		const input = [
			{
				role: "assistant",
				content: [{ type: "text", text: `clean\uD83D` }],
			},
		];
		const out = sanitizeMessages(input as never);
		assert.equal((out[0] as never as { content: { text: string }[] }).content[0]!.text, "clean");
	});

	it("strips lone surrogates from thinking content blocks", () => {
		const input = [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: `reasoning\uDC4B` }],
			},
		];
		const out = sanitizeMessages(input as never);
		assert.equal(
			(out[0] as never as { content: { thinking: string }[] }).content[0]!.thinking,
			"reasoning",
		);
	});

	it("preserves non-text content blocks unchanged", () => {
		const toolBlock = { type: "toolCall", name: "read", arguments: { path: "foo.ts" } };
		const input = [{ role: "assistant", content: [toolBlock] }];
		const out = sanitizeMessages(input as never);
		assert.deepEqual((out[0] as never as { content: unknown[] }).content[0], toolBlock);
	});

	it("does not mutate input array (returns new objects)", () => {
		const input = [
			{ role: "assistant", content: [{ type: "text", text: `clean\uD83D` }] },
		];
		const inputBefore = JSON.parse(JSON.stringify(input));
		sanitizeMessages(input as never);
		// The input still has the lone surrogate (because comparison via JSON.parse
		// strips it; do char-code check instead).
		assert.equal(
			((input[0] as never as { content: { text: string }[] }).content[0]!.text).charCodeAt(5),
			0xD83D,
		);
		// Just confirm the snapshot survived a JSON roundtrip — input wasn't mutated
		// out from under the caller.
		assert.deepEqual(JSON.parse(JSON.stringify(input)), inputBefore);
	});

	it("preserves messages without content arrays", () => {
		const input = [{ role: "user", content: "string content not array" }];
		const out = sanitizeMessages(input as never);
		assert.deepEqual(out, input);
	});
});
