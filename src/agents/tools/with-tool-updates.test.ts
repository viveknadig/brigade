import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { Type } from "typebox";

import {
	__resetAgentBusForTests,
	onAgentEvent,
	type AgentBusEvent,
} from "../agent-event-bus.js";
import { withToolUpdates, type BrigadeToolUpdateContextRef } from "./common.js";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	AnyBrigadeTool,
} from "./types.js";

/** Minimal Brigade tool that pushes one update then returns a result. */
function makeStreamingTool(opts: {
	updates?: AgentToolResult<unknown>[];
	throwOn?: "execute";
} = {}): AnyBrigadeTool {
	const updates = opts.updates ?? [
		{ content: [{ type: "text", text: "10% complete" }], details: { progress: 10 } },
	];
	return {
		name: "fake_streamer",
		label: "fake streamer",
		description: "Test tool that emits onUpdate then returns.",
		parameters: Type.Object({
			value: Type.String(),
		}),
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback,
		): Promise<AgentToolResult<unknown>> {
			for (const u of updates) onUpdate?.(u);
			if (opts.throwOn === "execute") {
				throw new Error("kaboom");
			}
			const value = (params as { value: string }).value;
			return {
				content: [{ type: "text", text: `done:${value}` }],
				details: { ok: true, value },
			};
		},
	};
}

describe("withToolUpdates", () => {
	afterEach(() => {
		__resetAgentBusForTests();
	});

	it("forwards onUpdate to the bus AND the original caller", async () => {
		const events: AgentBusEvent[] = [];
		onAgentEvent((e) => events.push(e));

		const callerSaw: unknown[] = [];
		const tool = makeStreamingTool({
			updates: [
				{ content: [{ type: "text", text: "step 1" }], details: { progress: 33 } },
				{ content: [{ type: "text", text: "step 2" }], details: { progress: 66 } },
			],
		});

		const ctxRef: BrigadeToolUpdateContextRef = {
			value: { runId: "r-1", agentId: "main", sessionKey: "sess-A" },
		};
		const wrapped = withToolUpdates(tool, ctxRef);

		const result = await wrapped.execute(
			"call-1",
			{ value: "hi" },
			undefined,
			(partial) => callerSaw.push(partial),
		);

		// Caller's onUpdate received both partials, in order.
		assert.equal(callerSaw.length, 2);
		assert.deepEqual(
			(callerSaw[0] as AgentToolResult<{ progress: number }>).details,
			{ progress: 33 },
		);
		assert.deepEqual(
			(callerSaw[1] as AgentToolResult<{ progress: number }>).details,
			{ progress: 66 },
		);

		// Bus saw both as tool-update events with correlation ids.
		const updates = events.filter((e) => e.type === "tool-update");
		assert.equal(updates.length, 2);
		for (const e of updates) {
			assert.equal(e.type, "tool-update");
			if (e.type !== "tool-update") continue;
			assert.equal(e.runId, "r-1");
			assert.equal(e.agentId, "main");
			assert.equal(e.sessionKey, "sess-A");
			assert.equal(e.toolName, "fake_streamer");
			assert.equal(e.toolCallId, "call-1");
		}

		// Original execute result still flows through unchanged.
		assert.deepEqual(result.details, { ok: true, value: "hi" });
	});

	it("emits events even when ctxRef is empty (no correlation ids)", async () => {
		const events: AgentBusEvent[] = [];
		onAgentEvent((e) => events.push(e));

		const tool = makeStreamingTool();
		const ctxRef: BrigadeToolUpdateContextRef = { value: {} };
		const wrapped = withToolUpdates(tool, ctxRef);

		await wrapped.execute("call-empty", { value: "x" }, undefined, undefined);

		const updates = events.filter((e) => e.type === "tool-update");
		assert.equal(updates.length, 1);
		const e = updates[0];
		assert.ok(e && e.type === "tool-update");
		assert.equal(e.runId, undefined);
		assert.equal(e.agentId, undefined);
		assert.equal(e.sessionKey, undefined);
		assert.equal(e.toolName, "fake_streamer");
		assert.equal(e.toolCallId, "call-empty");
		assert.deepEqual(
			(e.payload as AgentToolResult<{ progress: number }>).details,
			{ progress: 10 },
		);
	});

	it("preserves tool name, parameters, and result shape", async () => {
		const tool = makeStreamingTool();
		const wrapped = withToolUpdates(tool, { value: {} });

		// Identity-preserving metadata.
		assert.equal(wrapped.name, tool.name);
		assert.equal(wrapped.label, tool.label);
		assert.equal(wrapped.description, tool.description);
		assert.strictEqual(wrapped.parameters, tool.parameters);

		// Result shape unchanged by wrapping.
		const result = await wrapped.execute(
			"call-shape",
			{ value: "abc" },
			undefined,
			undefined,
		);
		assert.equal(result.content[0]?.type, "text");
		assert.equal((result.content[0] as { text: string }).text, "done:abc");
		assert.deepEqual(result.details, { ok: true, value: "abc" });
	});

	it("does not swallow errors thrown by the inner execute", async () => {
		const tool = makeStreamingTool({ throwOn: "execute" });
		const wrapped = withToolUpdates(tool, { value: { runId: "r-err" } });

		await assert.rejects(
			() => wrapped.execute("call-err", { value: "boom" }, undefined, undefined),
			(err: unknown) => err instanceof Error && /kaboom/.test(err.message),
		);
	});
});
