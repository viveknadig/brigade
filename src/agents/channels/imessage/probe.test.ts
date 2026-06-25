import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { IMessageRpcLike } from "./client.js";
import { probeIMessage, probeRpcSupport } from "./probe.js";

/** A fake RPC client that succeeds or fails the live `chats.list` call. */
class FakeRpcClient implements IMessageRpcLike {
	stopped = false;
	constructor(private readonly fail?: Error) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	async request<T = unknown>(): Promise<T> {
		if (this.fail) throw this.fail;
		return { chats: [] } as T;
	}
	async waitForClose(): Promise<void> {}
}

describe("probeRpcSupport", () => {
	it("reports supported when `imsg rpc --help` exits 0", async () => {
		const r = await probeRpcSupport({
			runHelp: async () => ({ stdout: "usage: imsg rpc", stderr: "", code: 0 }),
		});
		assert.equal(r.supported, true);
	});

	it("reports a FATAL error for an old binary without the rpc subcommand", async () => {
		const r = await probeRpcSupport({
			runHelp: async () => ({ stdout: "", stderr: "unknown command 'rpc'", code: 1 }),
		});
		assert.equal(r.supported, false);
		assert.equal(r.fatal, true);
	});

	it("reports a non-fatal failure for a non-zero exit", async () => {
		const r = await probeRpcSupport({
			runHelp: async () => ({ stdout: "", stderr: "boom", code: 2 }),
		});
		assert.equal(r.supported, false);
		assert.notEqual(r.fatal, true);
	});
});

describe("probeIMessage", () => {
	it("returns ok on a successful chats.list round-trip", async () => {
		const client = new FakeRpcClient();
		const res = await probeIMessage({
			runHelp: async () => ({ stdout: "ok", stderr: "", code: 0 }),
			createClient: async () => client,
		});
		assert.equal(res.ok, true);
		assert.equal(client.stopped, true);
	});

	it("returns ok:false (fatal) when the binary lacks rpc support", async () => {
		const res = await probeIMessage({
			runHelp: async () => ({ stdout: "", stderr: "unknown command 'rpc'", code: 1 }),
		});
		assert.equal(res.ok, false);
		assert.equal(res.fatal, true);
	});

	it("returns ok:false when the live chats.list call fails (never throws)", async () => {
		const res = await probeIMessage({
			runHelp: async () => ({ stdout: "ok", stderr: "", code: 0 }),
			createClient: async () => new FakeRpcClient(new Error("imsg rpc timeout (chats.list)")),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /chats\.list/);
	});
});
