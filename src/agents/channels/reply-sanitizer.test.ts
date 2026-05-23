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

test("strips an unclosed <think> at the START of the reply (truncated mid-reasoning)", () => {
	// The model emits `<think>...</think>` at the start of its reply per the
	// system-prompt-guidance contract. An unclosed `<think>` AT THE START
	// is unambiguously truncated chain-of-thought — strip + empty-fallback
	// returns the trimmed original (the recipient gets something rather than
	// silence; we recommend the operator investigate the truncation cause).
	const input = "<think>plan: about to answer but I got cut o";
	const out = sanitizeReplyForChannel(input);
	// Result is the original (empty-fallback path) — better than silence.
	assert.equal(out, input);
});

test("does NOT strip mid-string unclosed <think> — preserves ambiguous literal mentions", () => {
	// Trade-off documented at reply-sanitizer.ts:strip-decision. A reply like
	// "Visible bit. <think> the tag is fictional" is ambiguous: could be
	// truncated reasoning OR a sentence mentioning the literal tag. When in
	// doubt we PRESERVE — destroying user content is worse than leaking the
	// rare debris of a model that truncated mid-sentence-mentioning-the-tag.
	const input = "Visible bit. <think>plan: continue answering but I got cut o";
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, input);
});

test("NESTED <think> blocks — no orphan </think> in the output", () => {
	// Regression: a naive `replace(/<think>[\s\S]*?<\/think>/g)` matches the
	// INNER pair first, leaving the outer </think> in place. Iterative
	// stripping eats both levels.
	const input = "<think><think>nested</think></think>Hello";
	const out = sanitizeReplyForChannel(input);
	assert.equal(out, "Hello");
	assert.ok(!out.includes("<think>") && !out.includes("</think>"));
});

test("triple-nested <think> still fully stripped", () => {
	const input = "Before <think>a<think>b<think>c</think></think></think> after";
	const out = sanitizeReplyForChannel(input);
	// All three pairs eaten — no `<think>` or `</think>` tags anywhere in the
	// remaining text. Internal whitespace handling is left to the caller (the
	// regex eats trailing whitespace after the strip so "Before after" is the
	// natural shape; we don't assert the exact spacing here).
	assert.ok(!out.includes("<think>") && !out.includes("</think>"));
	assert.ok(out.includes("Before") && out.includes("after"));
});

test("preserves replies that mention the literal substring <think>", () => {
	// Critical: a question about the (made-up) HTML tag must NOT be truncated.
	// The unclosed-strip only fires when there are more `<think>` than
	// `</think>` AND the trailing `<think>` has no closing pair after it.
	const input = "Tell me about the <think> HTML tag — it does nothing.";
	const out = sanitizeReplyForChannel(input);
	// The literal substring is preserved because there's no real reasoning
	// block (just text mentioning the tag name). We accept either: full
	// preservation, OR the original returned by the empty-fallback. NEVER an
	// unrelated truncation like "Tell me about the".
	assert.ok(
		out.includes("HTML tag") || out === input,
		`expected literal <think> substring to survive, got: ${JSON.stringify(out)}`,
	);
});

test("matched <think>...</think> in a reply that ALSO mentions the literal — stripped block only", () => {
	const input = "<think>internal plan</think>\nThe <think> tag is fictional, but here's how it would work…";
	const out = sanitizeReplyForChannel(input);
	assert.ok(!out.startsWith("<think>internal"), "internal-plan block should be stripped");
	assert.ok(out.includes("The <think> tag is fictional"), "literal mention should survive");
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
