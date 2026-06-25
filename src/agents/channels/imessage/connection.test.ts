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

function account(overrides: Partial<ResolvedIMessageAccount> = {}): ResolvedIMessageAccount {
	return {
		accountId: "default",
		enabled: true,
		cliPath: "imsg",
		dbPath: "",
		service: "auto",
		region: "US",
		mediaMaxBytes: 16 * 1024 * 1024,
		probeTimeoutMs: 5_000,
		selfHandle: "",
		remoteHost: "",
		includeAttachments: true,
		defaultTo: "",
		historyLimit: 0,
		dmHistoryLimit: 0,
		textChunkLimit: 4_000,
		chunkMode: "length",
		verbose: false,
		...overrides,
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

/** A configurable fake whose `watch.subscribe` can fail the first K times. */
class ScriptedClient implements IMessageRpcLike {
	failsRemaining: number;
	subscribeCalls = 0;
	stopped = 0;
	constructor(failsRemaining = 0) {
		this.failsRemaining = failsRemaining;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped += 1;
	}
	async request<T = unknown>(method: string): Promise<T> {
		if (method === "watch.subscribe") {
			this.subscribeCalls += 1;
			if (this.failsRemaining > 0) {
				this.failsRemaining -= 1;
				throw new Error("imsg rpc timeout (watch.subscribe)");
			}
		}
		return {} as T;
	}
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
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
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
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			sleepImpl: async () => {},
		});
		assert.doesNotThrow(() => notifyBox.fn!({ method: "message", params: { not: "a message" } }));
		assert.ok(logs.some((l) => /malformed/.test(l)));
		await conn.close();
	});
});

describe("connectIMessage — watch-subscribe startup retry (Fix 6)", () => {
	it("retries a transient subscribe failure then connects without the full backoff", async () => {
		const logs: string[] = [];
		let connectedFired = false;
		// Fail the first 2 subscribe attempts, succeed on the 3rd.
		const client = new ScriptedClient(2);
		const conn = await connectIMessage({
			account: account(),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: (m) => logs.push(m),
			onMessage: () => {},
			onConnected: () => {
				connectedFired = true;
			},
			clientFactory: async () => client,
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			sleepImpl: async () => {},
		});
		assert.equal(client.subscribeCalls, 3, "subscribed 3 times (2 fail + 1 success)");
		assert.equal(connectedFired, true, "onConnected fired after the retry");
		assert.equal(conn.isConnected(), true);
		assert.ok(logs.some((l) => /watch\.subscribe startup failed.*retrying/.test(l)));
		await conn.close();
	});
});

describe("connectIMessage — waitForTransportReady gate (Fix 7)", () => {
	it("waits for the probe to become ready before subscribing", async () => {
		const logs: string[] = [];
		let ready = false;
		let probeCalls = 0;
		const client = new ScriptedClient(0);
		// First probe(s) not ready, then ready — subscribe must happen only after.
		const conn = await connectIMessage({
			account: account(),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: (m) => logs.push(m),
			onMessage: () => {},
			clientFactory: async () => client,
			probeImpl: async () => {
				probeCalls += 1;
				if (probeCalls >= 2) ready = true;
				return ready ? { ok: true, elapsedMs: 0 } : { ok: false, error: "starting", elapsedMs: 0 };
			},
			sleepImpl: async () => {},
		});
		assert.ok(probeCalls >= 2, "probed until ready");
		assert.equal(client.subscribeCalls, 1, "subscribed exactly once, after readiness");
		assert.equal(conn.isConnected(), true);
		await conn.close();
	});
});

describe("connectIMessage — group mentions + history (Fixes 2 & 9)", () => {
	it("attaches rolling history to an untagged group message and not to a tagged one", async () => {
		const delivered: Array<{ text: string; historyContext?: string; mentions?: string[] }> = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			account: account({ selfHandle: "15551234567", historyLimit: 5 }),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: () => {},
			onMessage: (m) =>
				delivered.push({
					text: m.text,
					...(m.historyContext ? { historyContext: m.historyContext } : {}),
					...(m.mentions ? { mentions: m.mentions } : {}),
				}),
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			sleepImpl: async () => {},
		});
		const push = (text: string, sender = "+1999") =>
			notifyBox.fn!({ method: "message", params: { message: { sender, text, chat_id: 7, is_group: true } } });
		// First untagged message: no prior history, recorded.
		push("first line");
		// Second untagged message: should carry the first as context.
		push("second line");
		// Third message TAGS the bot: no history context, mentions populated.
		push("hey 15551234567 help");
		assert.equal(delivered.length, 3);
		assert.equal(delivered[0]?.historyContext, undefined);
		assert.ok(delivered[1]?.historyContext, "untagged 2nd message carries history");
		assert.ok(delivered[1]?.historyContext?.includes("first line"));
		assert.equal(delivered[2]?.historyContext, undefined, "tagged message gets no history block");
		assert.deepEqual(delivered[2]?.mentions, ["15551234567"]);
		await conn.close();
	});
});

describe("connectIMessage — includeAttachments knob (Fix 10)", () => {
	const withMedia = {
		method: "message" as const,
		params: {
			message: {
				sender: "+1555",
				text: "see this",
				is_from_me: false,
				attachments: [{ original_path: "/Users/me/Library/Messages/Attachments/a/b/x.jpg", mime_type: "image/jpeg" }],
			},
		},
	};

	it("does NOT attach resolveMedia when includeAttachments is false", async () => {
		const delivered: Array<{ hasResolveMedia: boolean }> = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			account: account({ includeAttachments: false }),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: () => {},
			onMessage: (m) => delivered.push({ hasResolveMedia: typeof m.resolveMedia === "function" }),
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			sleepImpl: async () => {},
		});
		notifyBox.fn!(withMedia);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0]?.hasResolveMedia, false);
		await conn.close();
	});

	it("attaches resolveMedia when includeAttachments is true (default)", async () => {
		const delivered: Array<{ hasResolveMedia: boolean }> = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			account: account({ includeAttachments: true }),
			loadConfig: () => ({}) as unknown as BrigadeConfig,
			log: () => {},
			onMessage: (m) => delivered.push({ hasResolveMedia: typeof m.resolveMedia === "function" }),
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			sleepImpl: async () => {},
		});
		notifyBox.fn!(withMedia);
		assert.equal(delivered[0]?.hasResolveMedia, true);
		await conn.close();
	});
});

describe("connectIMessage — remote-host attachment fetch (Fix 4)", () => {
	it("resolves an inbound attachment via the mocked SCP copy when a remote cliPath is configured", async () => {
		const scpCalls: Array<{ remoteHost: string; remotePath: string }> = [];
		const captured: Array<{ resolveMedia?: () => Promise<unknown[]> }> = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			// An ssh-wrapper cliPath (≠ "imsg") auto-detects the remote host via readFileImpl.
			account: account({ cliPath: "/usr/local/bin/imsg-remote", includeAttachments: true }),
			loadConfig: () =>
				({
					channels: { imessage: { remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"] } },
				}) as unknown as BrigadeConfig,
			log: () => {},
			onMessage: (m) => captured.push({ ...(m.resolveMedia ? { resolveMedia: m.resolveMedia } : {}) }),
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			readFileImpl: async () => 'exec ssh -T brigade@mac-mini imsg "$@"\n',
			scpRunner: async (a) => {
				scpCalls.push({ remoteHost: a.remoteHost, remotePath: a.remotePath });
			},
			mkdtempImpl: async () => "/tmp/brigade-imsg-CCCC",
			sleepImpl: async () => {},
		});
		notifyBox.fn!({
			method: "message",
			params: {
				message: {
					sender: "+1555",
					text: "pic",
					is_from_me: false,
					attachments: [{ original_path: "/Users/me/Library/Messages/Attachments/a/b/x.jpg", mime_type: "image/jpeg" }],
				},
			},
		});
		// The deferred media thunk runs post-access-gate; invoke it explicitly.
		assert.equal(captured.length, 1);
		const resolveMedia = captured[0]?.resolveMedia;
		assert.ok(resolveMedia, "deferred media thunk present");
		const media = (await resolveMedia!()) as Array<{ path: string }>;
		assert.equal(media.length, 1, "one attachment resolved via SCP");
		assert.ok(media[0]?.path.replace(/\\/g, "/").startsWith("/tmp/brigade-imsg-CCCC/"), "points at the local copy");
		assert.equal(scpCalls.length, 1);
		assert.equal(scpCalls[0]?.remoteHost, "brigade@mac-mini");
		assert.equal(scpCalls[0]?.remotePath, "/Users/me/Library/Messages/Attachments/a/b/x.jpg");
		await conn.close();
	});

	it("uses LOCAL roots (no SCP) when the cliPath is the default 'imsg'", async () => {
		const scpCalls: number[] = [];
		const captured: Array<{ resolveMedia?: () => Promise<unknown[]> }> = [];
		const notifyBox: { fn: ((msg: IMessageRpcNotification) => void) | null } = { fn: null };
		const conn = await connectIMessage({
			account: account({ cliPath: "imsg", includeAttachments: true }),
			loadConfig: () =>
				({
					channels: { imessage: { attachmentRoots: ["/Users/*/Library/Messages/Attachments"] } },
				}) as unknown as BrigadeConfig,
			log: () => {},
			onMessage: (m) => captured.push({ ...(m.resolveMedia ? { resolveMedia: m.resolveMedia } : {}) }),
			clientFactory: async (opts) => {
				notifyBox.fn = opts.onNotification;
				return new FakeClient();
			},
			probeImpl: async () => ({ ok: true, elapsedMs: 0 }),
			scpRunner: async () => {
				scpCalls.push(1);
			},
			sleepImpl: async () => {},
		});
		notifyBox.fn!({
			method: "message",
			params: {
				message: {
					sender: "+1555",
					text: "pic",
					is_from_me: false,
					attachments: [{ original_path: "/Users/me/Library/Messages/Attachments/a/b/x.jpg", mime_type: "image/jpeg" }],
				},
			},
		});
		const resolveMedia = captured[0]?.resolveMedia;
		assert.ok(resolveMedia);
		const media = (await resolveMedia!()) as Array<{ path: string }>;
		assert.equal(media.length, 1);
		// Local resolution keeps the original on-disk path; no SCP runs.
		assert.equal(media[0]?.path, "/Users/me/Library/Messages/Attachments/a/b/x.jpg");
		assert.equal(scpCalls.length, 0, "no SCP for a local (default 'imsg') setup");
		await conn.close();
	});
});
