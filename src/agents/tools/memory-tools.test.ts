import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FileMemoryStore } from "../memory/storage.js";
import { makeReadMemoryTool, makeRecallMemoryTool } from "./memory-tools.js";

let workspace: string;
let store: FileMemoryStore;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-memtools-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
	store = new FileMemoryStore(workspace);
});

afterEach(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeMemory(rel: string, content: string): void {
	const full = path.join(workspace, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

describe("recall_memory tool", () => {
	it("has the expected name + shape", () => {
		const tool = makeRecallMemoryTool(store);
		assert.equal(tool.name, "recall_memory");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters);
		assert.match(tool.description, /search/i);
	});

	it("returns matching snippets with file:line citations", async () => {
		writeMemory("MEMORY.md", "User prefers concise replies.");
		writeMemory("memory/2026-05-21.md", "Project uses pytest with -n auto.");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "pytest auto" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /pytest/);
		assert.match(text, /memory\/2026-05-21\.md:/);
		assert.equal(result.details.resultCount >= 1, true);
	});

	it("reports cleanly when nothing matches + nudges toward writing", async () => {
		writeMemory("MEMORY.md", "unrelated");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "kubernetes helm chart" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /No memory matched/i);
		assert.match(text, /memory\/<today>\.md/);
		assert.equal(result.details.resultCount, 0);
	});

	it("throws on missing query (required param)", async () => {
		const tool = makeRecallMemoryTool(store);
		await assert.rejects(() => tool.execute("call-1", {} as never));
	});

	it("respects maxResults", async () => {
		writeMemory("MEMORY.md", "cat\n\ncat\n\ncat\n\ncat\n\ncat");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "cat", maxResults: 2 } as never);
		assert.equal(result.details.resultCount, 2);
	});
});

describe("read_memory tool", () => {
	it("has the expected name + shape", () => {
		const tool = makeReadMemoryTool(store);
		assert.equal(tool.name, "read_memory");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters);
	});

	it("reads a memory file and reports the line range", async () => {
		writeMemory("memory/2026-05-21.md", "first\nsecond\nthird");
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "memory/2026-05-21.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /memory\/2026-05-21\.md \(lines 1-3\)/);
		assert.match(text, /first\nsecond\nthird/);
		assert.equal(result.details.status, "ok");
	});

	it("surfaces a path-scope violation as a failed result (not a throw)", async () => {
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "USER.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /not a memory file/i);
		assert.equal(result.details.status, "failed");
	});

	it("surfaces a missing file as a failed result with a recovery hint", async () => {
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "memory/2099-01-01.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /does not exist/i);
		assert.equal(result.details.status, "failed");
	});

	it("windows large reads + reports more-from-line", async () => {
		const big = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n");
		writeMemory("MEMORY.md", big);
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "MEMORY.md", from: 1, lines: 50 } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /more from line 51/);
		assert.equal(result.details.read?.lines, 50);
	});

	it("throws on missing path (required param)", async () => {
		const tool = makeReadMemoryTool(store);
		await assert.rejects(() => tool.execute("call-1", {} as never));
	});
});
