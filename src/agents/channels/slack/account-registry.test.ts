import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	getSlackAccountSink,
	listSlackAccountSinks,
	registerSlackAccountSink,
	removeSlackAccountSink,
	resetSlackAccountSinksForTests,
	type SlackAccountSink,
} from "./account-registry.js";

/** A sink that records what it was fed. */
function makeSink(): SlackAccountSink & { fed: Array<{ kind: string; payload: unknown }> } {
	const fed: Array<{ kind: string; payload: unknown }> = [];
	return { fed, feedWebhookEvent: (kind, payload) => fed.push({ kind, payload }) };
}

describe("slack account-registry", () => {
	afterEach(() => resetSlackAccountSinksForTests());

	it("registers + resolves a per-account sink", () => {
		const acme = makeSink();
		registerSlackAccountSink("acme", acme);
		assert.equal(getSlackAccountSink("acme"), acme);
		assert.equal(getSlackAccountSink("labs"), undefined);
	});

	it("normalizes a blank/undefined accountId to the default slot", () => {
		const def = makeSink();
		registerSlackAccountSink("", def);
		assert.equal(getSlackAccountSink("default"), def);
		assert.equal(getSlackAccountSink("   "), def);
	});

	it("re-registering replaces the prior sink (restart-friendly)", () => {
		const first = makeSink();
		const second = makeSink();
		registerSlackAccountSink("acme", first);
		registerSlackAccountSink("acme", second);
		assert.equal(getSlackAccountSink("acme"), second);
	});

	it("removeSlackAccountSink drops only that account", () => {
		const acme = makeSink();
		const labs = makeSink();
		registerSlackAccountSink("acme", acme);
		registerSlackAccountSink("labs", labs);
		removeSlackAccountSink("acme");
		assert.equal(getSlackAccountSink("acme"), undefined);
		assert.equal(getSlackAccountSink("labs"), labs);
		assert.deepEqual(listSlackAccountSinks(), ["labs"]);
	});
});
