import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";
import {
	flattenConversation,
	getCursor,
	parseExtractedFacts,
	runExtractionSweep,
	storeExtractedFacts,
} from "./extract.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-extract-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("parseExtractedFacts", () => {
	it("parses a clean facts JSON object", () => {
		const facts = parseExtractedFacts(
			'{"facts":[{"content":"User is on Windows.","segment":"identity","importance":0.9}]}',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.segment, "identity");
		assert.equal(facts[0]?.importance, 0.9);
	});
	it("grabs JSON even when wrapped in prose / fences", () => {
		const facts = parseExtractedFacts(
			'Here you go:\n```json\n{"facts":[{"content":"Likes spaces.","segment":"preference"}]}\n```\nDone.',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "Likes spaces.");
	});
	it("returns [] on garbage / no JSON / empty", () => {
		assert.deepEqual(parseExtractedFacts("no json here"), []);
		assert.deepEqual(parseExtractedFacts(""), []);
		assert.deepEqual(parseExtractedFacts("{not valid"), []);
	});
	it("drops malformed fact entries (missing content/segment)", () => {
		const facts = parseExtractedFacts(
			'{"facts":[{"segment":"identity"},{"content":"ok","segment":"knowledge"},{"content":""}]}',
		);
		assert.equal(facts.length, 1);
		assert.equal(facts[0]?.content, "ok");
	});
});

describe("storeExtractedFacts", () => {
	it("stores valid segments + skips unknown ones + stamps corrects", () => {
		const n = storeExtractedFacts(
			dir,
			[
				{ content: "User uses pnpm... no, npm.", segment: "correction", corrects: "pnpm" },
				{ content: "Bad segment.", segment: "nonsense" },
				{ content: "Deploys Fridays.", segment: "project" },
			],
			"turn-1",
		);
		assert.equal(n, 2); // correction + project; nonsense skipped
		const store = new FactStore(dir);
		const all = store.list();
		assert.equal(all.length, 2);
		const correction = all.find((r) => r.segment === "correction");
		assert.equal(correction?.metadata?.corrects, "pnpm");
		assert.equal(correction?.sourceTurn, "turn-1");
	});
});

describe("flattenConversation", () => {
	it("renders user/assistant turns, skipping tool/system noise", () => {
		const text = flattenConversation([
			{ role: "user", content: "hey" },
			{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
			{ role: "tool", content: "ignored" },
			{ role: "user", content: "" }, // empty → skipped
		]);
		assert.equal(text, "USER: hey\n\nASSISTANT: hi there");
	});
});

describe("runExtractionSweep — batched, cursor-tracked, LLM injected", () => {
	const messages = [
		{ role: "user", content: "I'm Bhasvanth and I'm on Windows." },
		{ role: "assistant", content: "Noted!" },
	];

	it("distills new turns, stores facts, advances the cursor", async () => {
		const llm = async () => '{"facts":[{"content":"User name is Bhasvanth.","segment":"identity"}]}';
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, true);
		assert.equal(res.stored, 1);
		assert.equal(res.processedTo, 2);
		assert.equal(getCursor(dir, "s1"), 2);
		assert.equal(new FactStore(dir).list()[0]?.content, "User name is Bhasvanth.");
	});

	it("is a no-op when there's nothing new since the cursor (no LLM call)", async () => {
		let called = 0;
		const llm = async () => {
			called++;
			return "{}";
		};
		await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		called = 0; // reset after first real sweep
		// Second sweep over the SAME messages → cursor already at end → skip.
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, false);
		assert.equal(called, 0, "no second LLM call when nothing new");
	});

	it("does not advance the cursor if the LLM throws (retries next sweep)", async () => {
		const llm = async () => {
			throw new Error("provider down");
		};
		const res = await runExtractionSweep({ workspaceDir: dir, sessionId: "s1", messages, llm });
		assert.equal(res.ran, false);
		assert.equal(getCursor(dir, "s1"), 0, "cursor stays so the turns are retried");
	});

	it("respects minNewMessages (skips tiny slices without a call)", async () => {
		let called = 0;
		const llm = async () => {
			called++;
			return "{}";
		};
		const res = await runExtractionSweep({
			workspaceDir: dir,
			sessionId: "s1",
			messages: [{ role: "user", content: "hi" }],
			llm,
			minNewMessages: 2,
		});
		assert.equal(res.ran, false);
		assert.equal(called, 0);
	});
});
