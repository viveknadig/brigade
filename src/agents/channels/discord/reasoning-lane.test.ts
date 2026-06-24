import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { extractReasoning, REASONING_PREFIX, splitDiscordReasoning } from "./reasoning-lane.js";

describe("extractReasoning", () => {
	it("returns the contents of a closed think block", () => {
		assert.equal(extractReasoning("<think>step one</think>answer"), "step one");
	});

	it("concatenates multiple think blocks", () => {
		assert.equal(extractReasoning("<think>a</think>x<think>b</think>y"), "a\nb");
	});

	it("captures an unclosed trailing think block", () => {
		assert.equal(extractReasoning("<think>truncated reasoning"), "truncated reasoning");
	});

	it("returns empty when there is no reasoning", () => {
		assert.equal(extractReasoning("just an answer"), "");
	});

	it("handles <thinking> and <thought> variants", () => {
		assert.equal(extractReasoning("<thinking>r1</thinking>a"), "r1");
		assert.equal(extractReasoning("<thought>r2</thought>a"), "r2");
	});
});

describe("splitDiscordReasoning", () => {
	it("returns the sanitized answer plus a prefixed reasoning message", () => {
		const out = splitDiscordReasoning("<think>plan</think>The answer.");
		assert.equal(out.answerText, "The answer.");
		assert.equal(out.reasoningText, `${REASONING_PREFIX}plan`);
	});

	it("omits reasoning when none is present (answer unchanged)", () => {
		const out = splitDiscordReasoning("Plain answer.");
		assert.equal(out.answerText, "Plain answer.");
		assert.equal(out.reasoningText, undefined);
	});

	it("tolerates empty input", () => {
		const out = splitDiscordReasoning("");
		assert.equal(out.answerText, "");
		assert.equal(out.reasoningText, undefined);
	});
});
