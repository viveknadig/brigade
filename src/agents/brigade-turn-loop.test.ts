import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	__agentBusListenerCount,
	__resetAgentBusForTests,
	type AgentBusEvent,
	onAgentEvent,
} from "./agent-event-bus.js";

// We don't import `runBrigadeTurnLoop` here because it depends on a real
// Pi `AgentSession` (the wrappers introspect streamFn). What we CAN
// verify in unit tests is the bus event taxonomy: every lifecycle
// callback the loop fires has a corresponding event type, and the
// fields make sense. The actual integration runs through the smoke
// (`scripts/smoke-primitive-2.ps1`).

describe("agent-event-bus — Phase 5 lifecycle event types", () => {
	afterEach(() => {
		__resetAgentBusForTests();
	});

	it("turn-fallback-attempt event carries reason + next provider/model", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({
			type: "turn-fallback-attempt",
			runId: "r1",
			reason: "rate_limit",
			toProvider: "openrouter",
			toModelId: "openai/gpt-5.4-mini",
		});

		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.type, "turn-fallback-attempt");
		if (seen[0]?.type === "turn-fallback-attempt") {
			assert.equal(seen[0].reason, "rate_limit");
			assert.equal(seen[0].toProvider, "openrouter");
		}
	});

	it("turn-fallback-exhausted event carries final error reason", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({
			type: "turn-fallback-exhausted",
			runId: "r1",
			reason: "all candidates returned 429",
		});

		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.type, "turn-fallback-exhausted");
	});

	it("turn-heartbeat event carries elapsed milliseconds", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({ type: "turn-heartbeat", runId: "r1", elapsedMs: 30_000 });

		assert.equal(seen.length, 1);
		if (seen[0]?.type === "turn-heartbeat") {
			assert.equal(seen[0].elapsedMs, 30_000);
		}
	});

	it("turn-stream-timeout event carries idle threshold that tripped", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({ type: "turn-stream-timeout", runId: "r1", idleMs: 60_000 });

		assert.equal(seen.length, 1);
	});

	it("turn-length-continue event marks the resume-on-truncation branch", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({ type: "turn-length-continue", runId: "r1" });

		assert.equal(seen.length, 1);
	});

	it("turn-content-retry event tags reason: empty / reasoning-only / planning-only", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		for (const reason of ["empty", "reasoning-only", "planning-only"] as const) {
			emitAgentEvent({ type: "turn-content-retry", runId: "r1", reason });
		}

		assert.equal(seen.length, 3);
		assert.deepEqual(
			seen
				.filter((e): e is Extract<AgentBusEvent, { type: "turn-content-retry" }> =>
					e.type === "turn-content-retry",
				)
				.map((e) => e.reason),
			["empty", "reasoning-only", "planning-only"],
		);
	});

	it("turn-thinking-downgrade event records the original thinking level", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({ type: "turn-thinking-downgrade", runId: "r1", from: "high" });

		assert.equal(seen.length, 1);
		if (seen[0]?.type === "turn-thinking-downgrade") {
			assert.equal(seen[0].from, "high");
		}
	});

	it("a single listener correlates all events from one runId", async () => {
		const { emitAgentEvent } = await import("./agent-event-bus.js");
		const seen: AgentBusEvent[] = [];
		onAgentEvent((e) => seen.push(e));

		emitAgentEvent({ type: "turn-heartbeat", runId: "rA", elapsedMs: 30_000 });
		emitAgentEvent({ type: "turn-content-retry", runId: "rA", reason: "empty" });
		emitAgentEvent({
			type: "turn-fallback-attempt",
			runId: "rB",
			reason: "rate_limit",
			toProvider: undefined,
			toModelId: undefined,
		});

		const rA = seen.filter((e) => "runId" in e && e.runId === "rA");
		const rB = seen.filter((e) => "runId" in e && e.runId === "rB");
		assert.equal(rA.length, 2);
		assert.equal(rB.length, 1);
	});

	it("listener count returns to zero after disposers fire", () => {
		const dispose1 = onAgentEvent(() => {});
		const dispose2 = onAgentEvent(() => {});
		assert.equal(__agentBusListenerCount(), 2);
		dispose1();
		dispose2();
		assert.equal(__agentBusListenerCount(), 0);
	});
});
