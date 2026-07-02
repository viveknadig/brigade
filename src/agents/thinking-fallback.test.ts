import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { looksLikeThinkingNotSupported, runWithThinkingFallback } from "./thinking-fallback.js";

describe("looksLikeThinkingNotSupported", () => {
	it("matches Anthropic-style 'extended thinking' rejection", () => {
		assert.equal(
			looksLikeThinkingNotSupported("This model does not support extended thinking"),
			true,
		);
	});
	it("matches Gemini-style 'thinking_config' rejection", () => {
		assert.equal(
			looksLikeThinkingNotSupported("Invalid thinking_config: model does not allow thinking"),
			true,
		);
	});
	it("matches Ollama-style 'requires thinking_off' rejection", () => {
		assert.equal(
			looksLikeThinkingNotSupported("This route requires thinking_off"),
			true,
		);
	});
	it("matches generic 'thinking is not enabled' rejection", () => {
		assert.equal(looksLikeThinkingNotSupported("thinking is not enabled for this model"), true);
	});
	it("does NOT match unrelated errors", () => {
		assert.equal(looksLikeThinkingNotSupported("rate limit exceeded"), false);
		assert.equal(looksLikeThinkingNotSupported("invalid api key"), false);
		assert.equal(looksLikeThinkingNotSupported("context window exceeded"), false);
		assert.equal(looksLikeThinkingNotSupported(""), false);
	});
});

// Mock AgentSession just rich enough to exercise the wrapper.
type Msg = { role: string; content?: unknown; stopReason?: string; errorMessage?: string };

function mockSession(opts: {
	initialThinkingLevel?: string;
	messagesAfterFirst: Msg[];
	messagesAfterRetry?: Msg[];
}) {
	const messages: Msg[] = [];
	let firstPromptDone = false;
	let setThinkingCalls: string[] = [];
	let promptCalls: string[] = [];

	const session = {
		messages,
		thinkingLevel: opts.initialThinkingLevel ?? "high",
		setThinkingLevel(level: string) {
			this.thinkingLevel = level;
			setThinkingCalls.push(level);
		},
		async prompt(text: string) {
			promptCalls.push(text);
			if (!firstPromptDone) {
				firstPromptDone = true;
				// First prompt — append the initial user msg + the failure assistant msg.
				messages.push({ role: "user", content: [{ type: "text", text }] });
				messages.push(...opts.messagesAfterFirst);
			} else {
				// Retry — append the retry user + retry assistant.
				messages.push({ role: "user", content: [{ type: "text", text }] });
				if (opts.messagesAfterRetry) {
					messages.push(...opts.messagesAfterRetry);
				}
			}
		},
		agent: { state: { tools: [] } },
	};
	return { session, getCalls: () => ({ setThinkingCalls, promptCalls }) };
}

describe("runWithThinkingFallback", () => {
	it("does NOT retry when there's no error", async () => {
		const m = mockSession({
			messagesAfterFirst: [
				{ role: "assistant", content: [{ type: "text", text: "Hello!" }] },
			],
		});
		await runWithThinkingFallback(m.session as never, async () => {
			await m.session.prompt("hey");
		});
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 1);
		assert.equal(calls.setThinkingCalls.length, 0);
	});

	it("does NOT retry when error is unrelated to thinking", async () => {
		const m = mockSession({
			messagesAfterFirst: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "rate limit exceeded",
				},
			],
		});
		await runWithThinkingFallback(m.session as never, async () => {
			await m.session.prompt("hey");
		});
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 1);
		assert.equal(calls.setThinkingCalls.length, 0);
	});

	it("DOES retry on thinking-not-supported error, with thinking off", async () => {
		let onDowngradeCalled = false;
		const m = mockSession({
			initialThinkingLevel: "high",
			messagesAfterFirst: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Model does not support extended thinking",
				},
			],
			messagesAfterRetry: [
				{ role: "assistant", content: [{ type: "text", text: "OK now I'm here." }] },
			],
		});
		await runWithThinkingFallback(
			m.session as never,
			async () => {
				await m.session.prompt("hey");
			},
			{
				onDowngrade: () => {
					onDowngradeCalled = true;
				},
			},
		);
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 2);
		assert.deepEqual(calls.setThinkingCalls, ["off"]);
		assert.equal(onDowngradeCalled, true);
		// Retry was made with the SAME user text.
		assert.equal(calls.promptCalls[0], "hey");
		assert.equal(calls.promptCalls[1], "hey");
	});

	it("does NOT loop when already on thinking=off", async () => {
		const m = mockSession({
			initialThinkingLevel: "off",
			messagesAfterFirst: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "thinking is not enabled",
				},
			],
		});
		await runWithThinkingFallback(m.session as never, async () => {
			await m.session.prompt("hey");
		});
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 1, "should not retry when already off");
	});

	// THROW path: Brigade's agent loop converts a provider error-stop into a THROWN
	// error (assertNoProviderErrorStop) inside the body — so for providers like the
	// native Ollama transport the rejection arrives as an exception, not as session
	// data. The wrapper must still downgrade + retry (and re-throw unrelated errors).
	it("DOES downgrade + retry when body THROWS a thinking-not-supported error", async () => {
		let onDowngradeCalled = false;
		const m = mockSession({
			initialThinkingLevel: "high",
			messagesAfterFirst: [
				{ role: "assistant", content: [], stopReason: "error", errorMessage: '"qwen3-coder" does not support thinking' },
			],
			messagesAfterRetry: [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
		});
		let firstBody = true;
		await runWithThinkingFallback(
			m.session as never,
			async () => {
				await m.session.prompt("hey");
				if (firstBody) {
					firstBody = false;
					throw new Error('"qwen3-coder" does not support thinking');
				}
			},
			{ onDowngrade: () => { onDowngradeCalled = true; } },
		);
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 2, "downgrade retry fired despite the throw");
		assert.deepEqual(calls.setThinkingCalls, ["off"]);
		assert.equal(onDowngradeCalled, true);
	});

	it("RE-THROWS when body throws an error unrelated to thinking (preserves retry/fallback flow)", async () => {
		const m = mockSession({ messagesAfterFirst: [] });
		await assert.rejects(
			() =>
				runWithThinkingFallback(m.session as never, async () => {
					await m.session.prompt("hey");
					throw new Error("500 internal server error");
				}),
			/500 internal server error/,
		);
		const calls = m.getCalls();
		assert.equal(calls.promptCalls.length, 1, "no downgrade retry for a non-thinking error");
		assert.equal(calls.setThinkingCalls.length, 0);
	});
});
