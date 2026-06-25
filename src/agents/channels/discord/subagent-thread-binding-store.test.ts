/**
 * Discord sub-agent thread-binding STORE unit tests — the dependency-light
 * registry (no discord.js / REST import). Focused on the by-thread-id forget
 * helper the THREAD_UPDATE archive listener uses (Fix 6).
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	forgetDiscordSubagentThreadBindingByThreadId,
	getDiscordSubagentThreadBinding,
	listDiscordSubagentThreadBindings,
	rememberDiscordSubagentThreadBinding,
	resetDiscordSubagentThreadBindingsForTests,
} from "./subagent-thread-binding-store.js";

describe("discord subagent thread-binding store — forget by thread id (Fix 6)", () => {
	beforeEach(() => resetDiscordSubagentThreadBindingsForTests());
	afterEach(() => resetDiscordSubagentThreadBindingsForTests());

	it("drops the binding pointing at an archived thread id", () => {
		rememberDiscordSubagentThreadBinding({
			childSessionKey: "agent:scout:subagent:a:thread:T-1",
			threadId: "T-1",
			parentChannelId: "C-1",
			accountId: "default",
			agentId: "scout",
			boundAt: Date.now(),
		});
		assert.equal(listDiscordSubagentThreadBindings().length, 1);
		const dropped = forgetDiscordSubagentThreadBindingByThreadId("T-1");
		assert.equal(dropped, 1);
		assert.equal(getDiscordSubagentThreadBinding("agent:scout:subagent:a:thread:T-1"), undefined);
		assert.equal(listDiscordSubagentThreadBindings().length, 0);
	});

	it("is a no-op for a thread id with no binding", () => {
		rememberDiscordSubagentThreadBinding({
			childSessionKey: "agent:scout:subagent:a:thread:T-1",
			threadId: "T-1",
			parentChannelId: "C-1",
			accountId: "default",
			agentId: "scout",
			boundAt: Date.now(),
		});
		assert.equal(forgetDiscordSubagentThreadBindingByThreadId("T-999"), 0);
		assert.equal(forgetDiscordSubagentThreadBindingByThreadId(""), 0);
		assert.equal(forgetDiscordSubagentThreadBindingByThreadId(undefined), 0);
		assert.equal(listDiscordSubagentThreadBindings().length, 1, "unrelated binding untouched");
	});
});
