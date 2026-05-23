import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createHookRunner } from "./hook-runner.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import type { BrigadeConfig } from "../../config/io.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

describe("createHookRunner — void pattern", () => {
	it("runs every handler and swallows their errors", async () => {
		const calls: string[] = [];
		const runner = createHookRunner([
			{
				handler: async () => {
					calls.push("a");
				},
			},
			{
				handler: async () => {
					calls.push("b");
					throw new Error("boom");
				},
			},
			{
				handler: async () => {
					calls.push("c");
				},
			},
		]);
		const res = await runner.fire("turn_start", {});
		assert.equal(res.handlerCount, 3);
		// All three must have run despite the middle handler throwing.
		assert.deepEqual([...calls].sort(), ["a", "b", "c"]);
		// Void pattern does NOT report modifications / handled.
		assert.equal(res.modifications, undefined);
		assert.equal(res.handled, undefined);
	});

	it("returns sensible default when no handlers are registered", async () => {
		const runner = createHookRunner([]);
		const res = await runner.fire("agent_end", {});
		assert.equal(res.handlerCount, 0);
	});
});

describe("createHookRunner — modifying pattern", () => {
	it("runs sequentially by priority and merges modifications into the payload", async () => {
		const order: string[] = [];
		const runner = createHookRunner([
			{
				priority: 0,
				handler: (p) => {
					order.push(`low:${(p as { x?: number }).x ?? "?"}`);
					return { modifications: { x: 2 } };
				},
			},
			{
				priority: 100,
				handler: (p) => {
					order.push(`high:${(p as { x?: number }).x ?? "?"}`);
					return { modifications: { x: 1, y: "added" } };
				},
			},
		]);
		const payload = { x: 0 };
		const res = await runner.fire("before_prompt_build", payload);
		// High-priority runs first (sees original), low sees the patched x:1.
		assert.deepEqual(order, ["high:0", "low:1"]);
		// Final payload reflects the live shallow-merge.
		assert.equal(payload.x, 2);
		assert.equal((payload as Record<string, unknown>).y, "added");
		// Returned merged modifications are the union of all patches.
		assert.deepEqual(res.modifications, { x: 2, y: "added" });
		assert.equal(res.handlerCount, 2);
	});

	it("early-stops the chain on shouldStop:true and never runs later handlers", async () => {
		const ran: string[] = [];
		const runner = createHookRunner([
			{
				priority: 50,
				handler: () => {
					ran.push("first");
					return { modifications: { stamped: true }, shouldStop: true };
				},
			},
			{
				priority: 10,
				handler: () => {
					ran.push("second"); // must NOT run
					return { modifications: { extra: 1 } };
				},
			},
		]);
		const res = await runner.fire("message_sending", {});
		assert.deepEqual(ran, ["first"]);
		assert.deepEqual(res.modifications, { stamped: true });
	});

	it("isolates a throwing handler so the chain continues", async () => {
		const ran: string[] = [];
		const runner = createHookRunner([
			{
				priority: 10,
				handler: () => {
					ran.push("ok-1");
					return { modifications: { a: 1 } };
				},
			},
			{
				priority: 5,
				handler: () => {
					ran.push("throws");
					throw new Error("nope");
				},
			},
			{
				priority: 1,
				handler: () => {
					ran.push("ok-2");
					return { modifications: { b: 2 } };
				},
			},
		]);
		const res = await runner.fire("before_model_resolve", {});
		assert.deepEqual(ran, ["ok-1", "throws", "ok-2"]);
		assert.deepEqual(res.modifications, { a: 1, b: 2 });
	});
});

describe("createHookRunner — claiming pattern", () => {
	it("first handler returning handled:true wins; subsequent handlers do NOT run", async () => {
		const ran: string[] = [];
		const runner = createHookRunner([
			{
				priority: 100,
				handler: () => {
					ran.push("first");
					return {}; // does not claim
				},
			},
			{
				priority: 50,
				handler: () => {
					ran.push("claimer");
					return { handled: true };
				},
			},
			{
				priority: 10,
				handler: () => {
					ran.push("late"); // must NOT run
					return { handled: true };
				},
			},
		]);
		const res = await runner.fire("inbound_claim", { from: "alice" });
		assert.deepEqual(ran, ["first", "claimer"]);
		assert.equal(res.handled, true);
		assert.equal(res.by, 1); // 0-based index, after priority sort
	});

	it("returns handled:false when nobody claims", async () => {
		const runner = createHookRunner([
			{ handler: () => ({}) },
			{ handler: () => ({ handled: false }) },
			{ handler: () => undefined },
		]);
		const res = await runner.fire("reply_dispatch", {});
		assert.equal(res.handled, false);
		assert.equal(res.by, undefined);
		assert.equal(res.handlerCount, 3);
	});

	it("a throwing claim handler does not count as a claim", async () => {
		const runner = createHookRunner([
			{
				handler: () => {
					throw new Error("nope");
				},
			},
			{
				handler: () => ({ handled: true }),
			},
		]);
		const res = await runner.fire("before_dispatch", {});
		assert.equal(res.handled, true);
		assert.equal(res.by, 1);
	});
});

describe("createHookRunner — sync pattern", () => {
	it("runs handlers sequentially and synchronously", () => {
		const order: string[] = [];
		const runner = createHookRunner([
			{
				priority: 10,
				handler: () => {
					order.push("a");
				},
			},
			{
				priority: 5,
				handler: () => {
					order.push("b");
				},
			},
		]);
		// fire returns a Promise (uniform shape), but the handler bodies must have
		// already executed synchronously by the time fire's microtask resumes.
		const fired = runner.fire("tool_result_persist", {});
		assert.deepEqual(order, ["a", "b"]);
		return fired.then((res) => {
			assert.equal(res.handlerCount, 2);
		});
	});

	it("throws when a sync handler returns a Promise (pointing to the index)", async () => {
		const runner = createHookRunner([
			{
				handler: () => {
					/* ok */
				},
			},
			{
				handler: () => Promise.resolve(), // ← offender at index 1
			},
		]);
		await assert.rejects(runner.fire("before_message_write", {}), /index 1.*synchronous/i);
	});
});

describe("createHookRunner — handler ordering", () => {
	it("ties at the same priority keep registration order", async () => {
		const order: string[] = [];
		const runner = createHookRunner([
			{
				priority: 0,
				handler: () => {
					order.push("a");
				},
			},
			{
				priority: 0,
				handler: () => {
					order.push("b");
				},
			},
			{
				priority: 0,
				handler: () => {
					order.push("c");
				},
			},
		]);
		await runner.fire("turn_start", {});
		assert.deepEqual(order, ["a", "b", "c"]);
	});
});

describe("BrigadeExtensionRegistry.fireHook", () => {
	it("dispatches a claiming event to the matching event handlers only", async () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		// Different event — must be ignored.
		b.hook("turn_start", () => ({ handled: true }));
		// Two `inbound_claim` handlers: the high-priority one claims.
		b.hook("inbound_claim", () => ({}), { priority: 0 });
		b.hook("inbound_claim", () => ({ handled: true }), { priority: 100 });

		const res = await reg.fireHook("inbound_claim", { msg: "x" });
		assert.equal(res.handled, true);
		assert.equal(res.handlerCount, 2); // the turn_start handler was filtered out
	});

	it("dispatches a modifying event and reflects merged modifications on the payload", async () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.hook("before_prompt_build", () => ({ modifications: { tag: "x" } }), { priority: 50 });
		b.hook("before_prompt_build", () => ({ modifications: { extra: 1 } }), { priority: 10 });
		const payload: Record<string, unknown> = {};
		const res = await reg.fireHook("before_prompt_build", payload);
		assert.deepEqual(res.modifications, { tag: "x", extra: 1 });
		assert.equal(payload.tag, "x");
		assert.equal(payload.extra, 1);
	});

	it("returns handlerCount:0 when no handler matches the event", async () => {
		const reg = new BrigadeExtensionRegistry();
		const res = await reg.fireHook("agent_end", {});
		assert.equal(res.handlerCount, 0);
	});
});
