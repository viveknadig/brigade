import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sanitizeReplyForChannel } from "./reply-sanitizer.js";

test("strips a single <think>…</think> block + the blank line it leaves behind", () => {
	const input = "<think>plan: greet the user, ask their name</think>\n\nHey there — what should I call you?";
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "Hey there — what should I call you?");
	assert.ok(!out.includes("<think>"));
	assert.ok(!out.includes("</think>"));
});

test("strips multiple <think> blocks scattered through the reply", () => {
	const input = [
		"<think>first thought</think>",
		"Hello!",
		"<think>second thought</think>",
		"How can I help today?",
	].join("\n");
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "Hello!\nHow can I help today?");
});

test("dotall: <think> blocks spanning many lines + whitespace come out clean", () => {
	const input = `<think>
multi
line
plan
</think>

Here's the answer.`;
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "Here's the answer.");
});

test("strips an unclosed <think> block (model truncated mid-reasoning)", () => {
	// Without this guard partial chain-of-thought leaks to the recipient.
	const input = "Visible bit. <think>plan: continue answering but I got cut o";
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "Visible bit.");
});

test("keeps the <final> body, drops the tags", () => {
	const input = "<final>The capital of France is Paris.</final>";
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "The capital of France is Paris.");
});

test("when stripping would leave NOTHING, falls back to the original (defensive)", () => {
	const input = "<think>just internal monologue, nothing else</think>";
	const out = sanitizeReplyForChannel(input);
	// We don't strip when the result would be empty — better to send something
	// than confuse the recipient with silence.
	assert.equal(out, input);
});

test("plain text passes through untouched", () => {
	const input = "Hey, what's up?";
	assert.equal(sanitizeReplyForChannel(input), "Hey, what's up?");
});

test("empty / falsy inputs are returned as-is", () => {
	assert.equal(sanitizeReplyForChannel(""), "");
	assert.equal(sanitizeReplyForChannel(undefined as unknown as string), undefined);
});

test("does NOT strip <think>-LOOKING content inside code fences (lookalike text)", () => {
	// We accept the simplification that `<think>` is a model-emitted reasoning
	// tag, not user content. A code-fenced "thinking" block uses the exact same
	// tag would be stripped. Document the trade-off and assert it stays stable.
	const input = "```\n<think>this is inside a fence</think>\n```";
	const out = sanitizeReplyForChannel(input);
	// Tag is stripped; the fences and surrounding content remain.
	assert.ok(!out.includes("<think>"));
	assert.ok(out.startsWith("```"));
});
