import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createDraftStream, splitAtBoundary, TELEGRAM_STREAM_MAX_CHARS } from "./draft-stream.js";

/** A fake transport recording every send/edit so the state machine is observable. */
function makeFakeTransport() {
	const sends: Array<{ text: string; parseMode?: "HTML"; threadId?: string }> = [];
	const edits: Array<{ messageId: number; text: string; parseMode?: "HTML" }> = [];
	let nextId = 100;
	return {
		sends,
		edits,
		transport: {
			async sendMessage(text: string, opts: { parseMode?: "HTML"; threadId?: string }) {
				sends.push({ text, ...opts });
				return { messageId: nextId++ };
			},
			async editMessageText(messageId: number, text: string, opts: { parseMode?: "HTML" }) {
				edits.push({ messageId, text, ...opts });
			},
		},
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("splitAtBoundary", () => {
	it("returns the whole text when it fits", () => {
		assert.deepEqual(splitAtBoundary("hello", 10), ["hello", ""]);
	});

	it("splits on a paragraph break when one is past the half-way mark", () => {
		const text = "aaaaaa\n\nbbbbbb";
		const [head, rest] = splitAtBoundary(text, 10);
		assert.equal(head, "aaaaaa");
		assert.equal(rest, "bbbbbb");
	});

	it("hard-cuts when no boundary is available", () => {
		const text = "x".repeat(20);
		const [head, rest] = splitAtBoundary(text, 8);
		assert.equal(head.length, 8);
		assert.equal(rest.length, 12);
	});
});

describe("createDraftStream", () => {
	it("sends a placeholder on first flush then edits in place", async () => {
		const { sends, edits, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, throttleMs: 250 });
		stream.update("Hello");
		await stream.flush();
		assert.equal(sends.length, 1, "first content sends a new message");
		assert.equal(sends[0]?.text, "Hello");
		stream.update("Hello world");
		await stream.flush();
		assert.equal(sends.length, 1, "no second send — same message edited");
		assert.equal(edits.length, 1);
		assert.equal(edits[0]?.text, "Hello world");
		assert.equal(edits[0]?.messageId, sends[0] ? 100 : -1);
	});

	it("skips a no-op edit when the text is unchanged", async () => {
		const { edits, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport });
		stream.update("same");
		await stream.flush();
		stream.update("same");
		await stream.flush();
		assert.equal(edits.length, 0, "identical text never triggers an edit");
	});

	it("finalize delivers the final text and marks done", async () => {
		const { sends, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport });
		await stream.finalize("Final answer");
		assert.equal(sends.length, 1);
		assert.equal(sends[0]?.text, "Final answer");
		assert.equal(stream.isDone(), true);
		// Further updates are inert after finalize.
		stream.update("late");
		await stream.flush();
		assert.equal(sends.length, 1);
	});

	it("rolls to a NEW message when the answer exceeds the char limit", async () => {
		const { sends, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, maxChars: 20 });
		const head = "a".repeat(15);
		const tail = "b".repeat(15);
		await stream.finalize(`${head}\n\n${tail}`);
		assert.equal(sends.length, 2, "overflow rolls into a second message");
		assert.ok(sends[0]?.text.startsWith("a"));
		assert.ok(sends[1]?.text.startsWith("b"));
		assert.deepEqual(stream.messageIds(), [100, 101]);
	});

	it("applies a render hook (markdown→HTML) and parse mode", async () => {
		const { sends, transport } = makeFakeTransport();
		const stream = createDraftStream({
			transport,
			renderText: (t) => ({ text: `<b>${t}</b>`, parseMode: "HTML" }),
		});
		await stream.finalize("hi");
		assert.equal(sends[0]?.text, "<b>hi</b>");
		assert.equal(sends[0]?.parseMode, "HTML");
	});

	it("falls back to plain text when the render yields empty", async () => {
		const { sends, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, renderText: () => ({ text: "" }) });
		await stream.finalize("plain");
		assert.equal(sends[0]?.text, "plain");
		assert.equal(sends[0]?.parseMode, undefined);
	});

	it("never throws when the transport fails (stream is best-effort)", async () => {
		let calls = 0;
		const stream = createDraftStream({
			transport: {
				async sendMessage() {
					calls++;
					throw new Error("network down");
				},
				async editMessageText() {
					throw new Error("nope");
				},
			},
			warn: () => {},
		});
		await assert.doesNotReject(() => stream.finalize("anything"));
		assert.equal(calls, 1);
	});

	it("forwards threadId on the first send", async () => {
		const { sends, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, threadId: "42" });
		await stream.finalize("threaded");
		assert.equal(sends[0]?.threadId, "42");
	});

	it("caps maxChars at Telegram's hard limit", async () => {
		const { transport } = makeFakeTransport();
		// Requesting a huge maxChars is silently clamped — exercised by sending a
		// body just over the real limit and confirming a roll occurs.
		const stream = createDraftStream({ transport, maxChars: 999_999 });
		const huge = "z".repeat(TELEGRAM_STREAM_MAX_CHARS + 100);
		await stream.finalize(huge);
		assert.ok(stream.messageIds().length >= 2, "a body over 4096 must roll");
	});
});
