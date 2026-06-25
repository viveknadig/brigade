import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { IMessageRpcClient } from "./client.js";
import { createIMessageAdapter } from "./adapter.js";
import type { ConnectIMessageArgs, IMessageConnection } from "./connection.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";

const cfg = { channels: { imessage: { enabled: true } } } as never;

/** A fake connection that records sends + lets the test push inbound messages. */
function fakeConnection(): IMessageConnection & { sentText: Array<{ to: string; text: string }> } {
	const sentText: Array<{ to: string; text: string }> = [];
	return {
		sentText,
		isConnected: () => true,
		connectedAt: () => Date.now(),
		async sendText(conversationId, text): Promise<{ messageId?: string }> {
			sentText.push({ to: conversationId, text });
			return { messageId: "M-1" };
		},
		async sendMedia(): Promise<{ messageId?: string }> {
			return { messageId: "M-2" };
		},
		async close(): Promise<void> {},
	};
}

function startCtx(onInbound: (m: InboundMessage) => Promise<void>): ChannelStartContext {
	return {
		onInbound,
		log: () => {},
		signal: new AbortController().signal,
	};
}

describe("createIMessageAdapter", () => {
	it("is configured when the channel is enabled", () => {
		const adapter = createIMessageAdapter();
		assert.equal(adapter.isConfigured(cfg), true);
		assert.equal(adapter.isConfigured({ channels: {} } as never), false);
	});

	it("dispatches a normalized inbound through onInbound", async () => {
		const captured: ConnectIMessageArgs[] = [];
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({
			connectImpl: async (args) => {
				captured.push(args);
				return conn;
			},
		});
		const received: InboundMessage[] = [];
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async (m) => void received.push(m)));
		const args = captured[0];
		assert.ok(args);
		// Push a dispatched inbound (the connection emits the post-gating shape).
		args.onMessage({
			conversationId: "+1555",
			from: "+1555",
			text: "hello",
			isGroup: false,
			raw: { sender: "+1555", text: "hello" },
		});
		assert.equal(received.length, 1);
		assert.equal(received[0]?.channel, "imessage");
		assert.equal(received[0]?.from, "+1555");
		assert.equal(received[0]?.chatType, "direct");
	});

	it("chunk-sends + plain-text-ifies markdown tables on sendText", async () => {
		const conn = fakeConnection();
		const adapter = createIMessageAdapter({ connectImpl: async () => conn });
		adapter.isConfigured(cfg);
		await adapter.start(startCtx(async () => {}));
		await adapter.sendText("+1555", "| a | b |\n| --- | --- |\n| 1 | 2 |");
		assert.equal(conn.sentText.length, 1);
		assert.ok(!conn.sentText[0]?.text.includes("---"));
		assert.ok(conn.sentText[0]?.text.includes("a | b"));
	});

	it("reports starting health before start", () => {
		const adapter = createIMessageAdapter();
		const h = adapter.health?.();
		assert.equal(h?.ok, false);
		if (h && !h.ok) assert.equal(h.kind, "starting");
	});
});

describe("IMessageRpcClient (test-env guard)", () => {
	it("refuses to spawn a subprocess in the test environment", async () => {
		// The guard fires under NODE_ENV=test / VITEST. The hermetic runner doesn't
		// pin NODE_ENV, so force it for this one assertion (restore after) to prove
		// the production guard refuses rather than shelling out to a real binary.
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			const client = new IMessageRpcClient({ cliPath: "imsg" });
			await assert.rejects(() => client.start(), /Refusing to start imsg rpc/);
		} finally {
			if (prev === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prev;
		}
	});
});
