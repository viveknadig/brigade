/**
 * iMessage rolling group-history context (Fix 9).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { IMessageHistoryBuffer, renderIMessageHistoryBlock } from "./history.js";

describe("IMessageHistoryBuffer", () => {
	it("returns the last N entries oldest-first", () => {
		const buf = new IMessageHistoryBuffer();
		buf.record("chat:1", { sender: "Alice", body: "one" });
		buf.record("chat:1", { sender: "Bob", body: "two" });
		buf.record("chat:1", { sender: "Alice", body: "three" });
		const recent = buf.recent("chat:1", 2);
		assert.deepEqual(recent, [
			{ sender: "Bob", body: "two" },
			{ sender: "Alice", body: "three" },
		]);
	});

	it("scopes buffers per conversation", () => {
		const buf = new IMessageHistoryBuffer();
		buf.record("chat:1", { sender: "A", body: "x" });
		buf.record("chat:2", { sender: "B", body: "y" });
		assert.deepEqual(buf.recent("chat:1", 5), [{ sender: "A", body: "x" }]);
		assert.deepEqual(buf.recent("chat:2", 5), [{ sender: "B", body: "y" }]);
	});

	it("ignores empty bodies and returns [] for limit<=0", () => {
		const buf = new IMessageHistoryBuffer();
		buf.record("chat:1", { sender: "A", body: "   " });
		buf.record("chat:1", { sender: "A", body: "real" });
		assert.deepEqual(buf.recent("chat:1", 0), []);
		assert.deepEqual(buf.recent("chat:1", 5), [{ sender: "A", body: "real" }]);
	});

	it("truncates an over-long body", () => {
		const buf = new IMessageHistoryBuffer();
		buf.record("chat:1", { sender: "A", body: "y".repeat(5_000) });
		const [entry] = buf.recent("chat:1", 1);
		assert.ok(entry);
		assert.ok(entry!.body.length <= 2_010);
		assert.ok(entry!.body.endsWith("..."));
	});
});

describe("renderIMessageHistoryBlock", () => {
	it("renders a fenced context block", () => {
		const block = renderIMessageHistoryBlock([
			{ sender: "Alice", body: "hi" },
			{ sender: "me", body: "hello" },
		]);
		assert.equal(block, "[recent conversation context]\nAlice: hi\nme: hello\n[end context]");
	});

	it("returns '' for no entries", () => {
		assert.equal(renderIMessageHistoryBlock([]), "");
	});
});
