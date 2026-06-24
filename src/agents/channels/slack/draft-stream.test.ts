import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createDraftStream, splitAtBoundary, SLACK_STREAM_MAX_CHARS } from "./draft-stream.js";

/** A fake transport recording every post/update so the state machine is observable. */
function makeFakeTransport() {
	const posts: Array<{ text: string; threadId?: string }> = [];
	const edits: Array<{ ts: string; text: string }> = [];
	let nextId = 100;
	return {
		posts,
		edits,
		transport: {
			async postMessage(text: string, opts: { threadId?: string }) {
				posts.push({ text, ...opts });
				return { ts: String(nextId++) };
			},
			async updateMessage(ts: string, text: string) {
				edits.push({ ts, text });
			},
		},
	};
}

describe("splitAtBoundary", () => {
	it("returns the whole text when it fits", () => {
		assert.deepEqual(splitAtBoundary("hello", 10), ["hello", ""]);
	});

	it("splits on a paragraph break when one is past the half-way mark", () => {
		const [head, rest] = splitAtBoundary("aaaaaa\n\nbbbbbb", 10);
		assert.equal(head, "aaaaaa");
		assert.equal(rest, "bbbbbb");
	});

	it("hard-cuts when no boundary is available", () => {
		const [head, rest] = splitAtBoundary("x".repeat(20), 8);
		assert.equal(head.length, 8);
		assert.equal(rest.length, 12);
	});
});

describe("createDraftStream", () => {
	it("posts a placeholder on first flush then edits in place", async () => {
		const { posts, edits, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, throttleMs: 250 });
		stream.update("Hello");
		await stream.flush();
		assert.equal(posts.length, 1);
		assert.equal(posts[0]?.text, "Hello");
		stream.update("Hello world");
		await stream.flush();
		assert.equal(posts.length, 1, "no second post — same message edited");
		assert.equal(edits.length, 1);
		assert.equal(edits[0]?.text, "Hello world");
		assert.equal(edits[0]?.ts, "100");
	});

	it("skips a no-op edit when the text is unchanged", async () => {
		const { edits, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport });
		stream.update("same");
		await stream.flush();
		stream.update("same");
		await stream.flush();
		assert.equal(edits.length, 0);
	});

	it("finalize delivers the final text and marks done", async () => {
		const { posts, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport });
		await stream.finalize("Final answer");
		assert.equal(posts.length, 1);
		assert.equal(posts[0]?.text, "Final answer");
		assert.equal(stream.isDone(), true);
		stream.update("late");
		await stream.flush();
		assert.equal(posts.length, 1);
	});

	it("rolls to a NEW message when the answer exceeds the char limit", async () => {
		const { posts, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, maxChars: 20 });
		const head = "a".repeat(15);
		const tail = "b".repeat(15);
		await stream.finalize(`${head}\n\n${tail}`);
		assert.equal(posts.length, 2);
		assert.ok(posts[0]?.text.startsWith("a"));
		assert.ok(posts[1]?.text.startsWith("b"));
		assert.deepEqual(stream.messageIds(), ["100", "101"]);
	});

	it("applies a render hook (markdown→mrkdwn)", async () => {
		const { posts, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, renderText: (t) => ({ text: `*${t}*` }) });
		await stream.finalize("hi");
		assert.equal(posts[0]?.text, "*hi*");
	});

	it("falls back to plain text when the render yields empty", async () => {
		const { posts, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, renderText: () => ({ text: "" }) });
		await stream.finalize("plain");
		assert.equal(posts[0]?.text, "plain");
	});

	it("never throws when the transport fails (stream is best-effort)", async () => {
		let calls = 0;
		const stream = createDraftStream({
			transport: {
				async postMessage() {
					calls++;
					throw new Error("network down");
				},
				async updateMessage() {
					throw new Error("nope");
				},
			},
			warn: () => {},
		});
		await assert.doesNotReject(() => stream.finalize("anything"));
		assert.equal(calls, 1);
	});

	it("forwards threadId on the first post", async () => {
		const { posts, transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, threadId: "42.0" });
		await stream.finalize("threaded");
		assert.equal(posts[0]?.threadId, "42.0");
	});

	it("caps maxChars at Slack's hard limit", async () => {
		const { transport } = makeFakeTransport();
		const stream = createDraftStream({ transport, maxChars: 999_999 });
		const huge = "z".repeat(SLACK_STREAM_MAX_CHARS + 100);
		await stream.finalize(huge);
		assert.ok(stream.messageIds().length >= 2, "a body over the limit must roll");
	});
});
