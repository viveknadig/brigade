/**
 * Focused test for `modelSupportsImageInput` — the helper that reads the
 * resolved Pi `Model.input` to populate `analyze_media`'s authoritative
 * `imageInput` capability flag (fix for the text-only-vs-vision routing).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { modelSupportsImageInput } from "./agent-loop.js";

describe("modelSupportsImageInput", () => {
	it("true when input includes image", () => {
		assert.equal(modelSupportsImageInput({ input: ["text", "image"] }), true);
	});
	it("false when input is text-only", () => {
		assert.equal(modelSupportsImageInput({ input: ["text"] }), false);
	});
	it("undefined when input is missing / not an array (unknown → fall back to heuristic)", () => {
		assert.equal(modelSupportsImageInput({}), undefined);
		assert.equal(modelSupportsImageInput({ input: "image" }), undefined);
		assert.equal(modelSupportsImageInput(null), undefined);
		assert.equal(modelSupportsImageInput(undefined), undefined);
	});
});
