import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { createBrigadeTools, listBrigadeToolNames } from "./registry.js";

// createBrigadeTools constructs a FileMemoryStore rooted at workspaceDir.
// Point it at a tempdir so the tools are real but isolated.
let tmpWorkspace: string;

before(() => {
	tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-"));
});

after(() => {
	try {
		fs.rmSync(tmpWorkspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("createBrigadeTools — Primitive #4 (memory)", () => {
	it("returns the two memory read tools (recall_memory + read_memory)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		assert.equal(tools.length, 2);
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["read_memory", "recall_memory"]);
	});

	it("each tool has the required AgentTool shape", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		for (const tool of tools) {
			assert.equal(typeof tool.name, "string");
			assert.equal(typeof tool.label, "string");
			assert.equal(typeof tool.description, "string");
			assert.ok(tool.parameters, "parameters schema present");
			assert.equal(typeof tool.execute, "function");
		}
	});

	it("does NOT include a write tool (writing goes through the file tool — OpenClaw model)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("write_memory"), "no write_memory tool in v1");
	});

	it("does not throw on common option shapes (Windows + POSIX paths)", () => {
		assert.doesNotThrow(() =>
			createBrigadeTools({
				workspaceDir: "C:\\Users\\me\\.brigade\\workspace",
				agentId: "main",
				cwd: "C:\\Users\\me",
			}),
		);
	});
});

describe("listBrigadeToolNames", () => {
	it("returns the memory tool names", () => {
		assert.deepEqual(listBrigadeToolNames().sort(), ["read_memory", "recall_memory"]);
	});

	it("returns a fresh array on each call (callers may mutate)", () => {
		const a = listBrigadeToolNames();
		const b = listBrigadeToolNames();
		assert.notEqual(a, b, "different array instances");
		a.push("test-pollution");
		assert.deepEqual(
			listBrigadeToolNames().sort(),
			["read_memory", "recall_memory"],
			"subsequent calls unaffected",
		);
	});
});
