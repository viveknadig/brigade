/**
 * iMessage connection — notification-handler robustness (Fix 8).
 *
 * A synchronous throw inside the notification handler (malformed payload, a
 * downstream onMessage error) must NOT escape into the RPC client's read loop /
 * crash the gateway. The handler wraps its body in try/catch + log, so a single
 * bad notification is dropped and the loop survives — a subsequent good
 * notification still dispatches.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { connectIMessage } from "./connection.js";
import type { IMessageRpcLike, IMessageRpcNotification } from "./client.js";
import type { ResolvedIMessageAccount } from "./account-config.js";
import type { BrigadeConfig } from "../sdk.js";

function account(): ResolvedIMessageAccount {
	return {
		accountId: "default",
		enabled: true,
		cliPath: "imsg",
		dbPath: "",
		service: "auto",
		region: "US",
		mediaMaxBytes: 16 * 1024 * 1024,
		probeTimeoutMs: 5_000,
		verbose: false,
	};
}

/** A fake RPC client that captures nothing itself — the factory captures onNotification. */
class FakeClient implements IMessageRpcLike {
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async request<T = unknown>(): Promise<T> {
		return {} as T;
	}
	// Never resolves — keeps the supervise loop blocked on the live client.
	waitForClose(): Promise<void> {
		return new Promise<void>(() => {});
	}
}

describe("connectIMessage — notification handler robustness", () => {
	it("catches a throw from a downstream handler and keeps the loop alive", async () => {
		const logs: string[] = [];
		const delivered: string[] = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		let throwOnce = true;

		const conn = await connectIMessage({
			account: account(),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: (m) => logs.push(m),
			onMessage: (msg) => {
				// First good message throws (simulates a downstream bug); later ones
				// dispatch normally.
				if (throwOnce) {
					throwOnce = false;
					throw new Error("boom from onMessage");
				}
				delivered.push(msg.text);
			},
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			sleepImpl: async () => {},
		});

		assert.ok(notifyBox.fn, "the client factory received the onNotification callback");
		// 1) A notification whose downstream handler throws — must be caught.
		assert.doesNotThrow(() =>
			notifyBox.fn!({ method: "message", params: { message: { sender: "+1555", text: "first", is_from_me: false } } }),
		);
		assert.ok(
			logs.some((l) => /notification handler threw/.test(l)),
			"the throw was logged, not propagated",
		);
		// 2) A subsequent valid notification still dispatches — the loop survived.
		notifyBox.fn!({ method: "message", params: { message: { sender: "+1555", text: "second", is_from_me: false } } });
		assert.deepEqual(delivered, ["second"]);

		await conn.close();
	});

	it("drops a malformed payload without throwing", async () => {
		const logs: string[] = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			account: account(),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: (m) => logs.push(m),
			onMessage: () => {},
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			sleepImpl: async () => {},
		});
		assert.doesNotThrow(() => notifyBox.fn!({ method: "message", params: { not: "a message" } }));
		assert.ok(logs.some((l) => /malformed/.test(l)));
		await conn.close();
	});
});
