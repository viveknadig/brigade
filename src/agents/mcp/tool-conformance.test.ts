// Conformance: every tool Brigade serves over the MCP tool-plane must be
// something the `claude` binary's MCP client can actually consume.
//
// The plane advertises tools via `tools/list`, whose `inputSchema` is the tool's
// TypeBox `parameters` serialized to JSON. TypeBox IS JSON Schema, so this works
// — but nothing enforced it. A future tool defined with a schema that doesn't
// serialize to `{type:"object", properties}`, or whose namespaced name overflows
// the 64-char tool-name limit, would poison the WHOLE `tools/list` response and
// silently leave the agent with no tools at all.
//
// So build the REAL toolset (not fixtures) and assert each tool is serviceable.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { assembleBrigadeToolset } from "../session-wiring.js";
import { createGuardedBuiltinTools } from "./builtin-tools.js";
import { buildMcpTurnServer } from "./route.js";
import type { AnyBrigadeTool } from "../tools/types.js";

/** The binary namespaces every MCP tool as `mcp__<server>__<tool>`. */
const MCP_PREFIX = "mcp__brigade__";
/** Anthropic's tool-name limit; the namespaced name must fit. */
const MAX_TOOL_NAME = 64;
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function realToolset(): { native: AnyBrigadeTool[]; builtins: AnyBrigadeTool[]; builtinNames: string[] } {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-conformance-"));
	const toolset = assembleBrigadeToolset({
		workspaceDir: ws,
		agentId: "main",
		cwd: ws,
		senderIsOwner: true,
		// Present on a real owner turn — this is what puts spawn_agent on the surface.
		subagentContext: { parentSessionKey: "agent:main:main", callerDepth: 0 },
	});
	const builtins = createGuardedBuiltinTools({ cwd: ws, allow: toolset.builtinToolNames });
	return { native: toolset.customTools, builtins, builtinNames: [...toolset.builtinToolNames] };
}

test("the plane serves the native tools AND Pi's builtins", () => {
	const { native, builtins, builtinNames } = realToolset();
	assert.ok(native.length > 15, `expected the full native surface, got ${native.length}`);
	assert.deepEqual(
		builtins.map((t) => t.name).sort(),
		[...builtinNames].sort(),
		"every builtin the turn allows is constructed — Pi's loop can't build them here",
	);
	// Spot-check the ones that make this backend usable at all.
	const names = new Set([...native, ...builtins].map((t) => t.name));
	for (const required of ["bash", "read", "write", "edit", "grep", "ls", "write_memory", "recall_memory", "spawn_agent"]) {
		assert.ok(names.has(required), `tool-plane is missing '${required}'`);
	}
});

test("every served tool has an MCP-legal name that survives namespacing", () => {
	const { native, builtins } = realToolset();
	for (const t of [...native, ...builtins]) {
		assert.match(t.name, NAME_RE, `illegal MCP tool name: ${t.name}`);
		const full = `${MCP_PREFIX}${t.name}`;
		assert.ok(full.length <= MAX_TOOL_NAME, `namespaced name overflows ${MAX_TOOL_NAME}: ${full} (${full.length})`);
		assert.equal(typeof t.description, "string");
		assert.ok((t.description ?? "").length > 0, `tool has no description: ${t.name}`);
	}
});

test("every served tool's schema serializes to a valid MCP inputSchema", () => {
	const { native, builtins } = realToolset();
	for (const t of [...native, ...builtins]) {
		let schema: { type?: unknown; properties?: unknown; required?: unknown };
		assert.doesNotThrow(() => {
			// TypeBox carries symbol-keyed internals; they must drop cleanly.
			schema = JSON.parse(JSON.stringify(t.parameters));
		}, `schema is not JSON-serializable: ${t.name}`);
		schema = JSON.parse(JSON.stringify(t.parameters));

		assert.equal(schema.type, "object", `inputSchema.type must be "object": ${t.name}`);
		assert.equal(typeof schema.properties, "object", `inputSchema.properties missing: ${t.name}`);
		assert.notEqual(schema.properties, null, `inputSchema.properties is null: ${t.name}`);
		if (schema.required !== undefined) {
			assert.ok(Array.isArray(schema.required), `inputSchema.required must be an array: ${t.name}`);
			for (const key of schema.required as string[]) {
				assert.ok(
					Object.hasOwn(schema.properties as object, key),
					`required '${key}' is absent from properties: ${t.name}`,
				);
			}
		}
	}
});

test("tools/list over the real toolset round-trips through JSON intact", async () => {
	const { native, builtins } = realToolset();
	const all = [...native, ...builtins];
	const server = buildMcpTurnServer({ customTools: all, guard: async () => undefined, agentId: "main" });

	const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const listed = (res?.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
	assert.equal(listed.length, all.length, "every tool is advertised");

	// This is the actual wire step: the route JSON-encodes the response. If ANY
	// schema were unserializable the whole list would fail, not just that tool.
	const wire = JSON.parse(JSON.stringify(res));
	const wireTools = wire.result.tools as Array<{ name: string; inputSchema: { type: string } }>;
	assert.equal(wireTools.length, all.length);
	for (const t of wireTools) {
		assert.equal(t.inputSchema.type, "object", `${t.name} lost its schema on the wire`);
	}
	// names are unique — a duplicate would make one tool unreachable by name
	assert.equal(new Set(wireTools.map((t) => t.name)).size, wireTools.length, "duplicate tool name");
});

test("no served tool collides with a builtin name (the guarded one must win)", () => {
	const { native, builtins } = realToolset();
	const builtinNames = new Set(builtins.map((t) => t.name));
	const collisions = native.filter((t) => builtinNames.has(t.name)).map((t) => t.name);
	assert.deepEqual(collisions, [], `native tool shadows a builtin: ${collisions.join(", ")}`);
});
