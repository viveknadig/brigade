import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import { BrigadeExtensionRegistry } from "../../extensions/registry.js";
import type { ChannelStartContext } from "../sdk.js";
import { createWhatsAppAdapter } from "./adapter.js";
import type { ConnectWhatsAppArgs, WaSendTextOpts, WhatsAppConnection } from "./connection.js";
import { whatsAppModule } from "./module.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

/** Recorded `sendText` calls on the fake WhatsApp connection. */
interface FakeWaSendCall {
	conversationId: string;
	text: string;
	opts?: WaSendTextOpts;
}

/**
 * Build a fake `connectImpl` + a getter for the recorded `sendText` calls, so a
 * test can drive the adapter's outbound path without a live Baileys socket.
 * Mirrors the Telegram adapter test's `makeFakeConnectImpl`.
 */
function makeFakeWaConnect(): {
	connectImpl: (a: ConnectWhatsAppArgs) => Promise<WhatsAppConnection>;
	sends: () => FakeWaSendCall[];
} {
	const sends: FakeWaSendCall[] = [];
	const connectImpl = async (args: ConnectWhatsAppArgs): Promise<WhatsAppConnection> => {
		const conn: WhatsAppConnection = {
			current: () => null,
			selfId: () => "15550000000",
			connectedAt: () => Date.now(),
			lastInboundAt: () => Date.now(),
			lastActivityAt: () => Date.now(),
			sendText: async (conversationId, text, opts) => {
				sends.push({ conversationId, text, opts });
			},
			sendMedia: async () => {},
			react: async () => {},
			markRead: async () => {},
			setComposing: async () => {},
			close: async () => {},
		};
		// Fire onConnected so the adapter flips healthy (so sendText isn't refused).
		args.onConnected?.();
		return conn;
	};
	return { connectImpl, sends: () => sends };
}

function makeWaStartCtx(over: Partial<ChannelStartContext> = {}): ChannelStartContext {
	return {
		signal: new AbortController().signal,
		log: () => {},
		onInbound: async () => {},
		...over,
	} as ChannelStartContext;
}

describe("WhatsApp adapter", () => {
	it("identifies as the whatsapp channel", () => {
		const a = createWhatsAppAdapter();
		assert.equal(a.id, "whatsapp");
		assert.equal(a.label, "WhatsApp");
	});

	it("is configured only when channels.whatsapp.enabled is true", () => {
		const a = createWhatsAppAdapter();
		assert.equal(a.isConfigured({} as BrigadeConfig), false);
		assert.equal(a.isConfigured({ channels: { whatsapp: {} } } as unknown as BrigadeConfig), false);
		assert.equal(a.isConfigured({ channels: { whatsapp: { enabled: false } } } as unknown as BrigadeConfig), false);
		assert.equal(a.isConfigured({ channels: { whatsapp: { enabled: true } } } as unknown as BrigadeConfig), true);
	});

	it("legacy adapter steps aside when multi-account config is declared (Wave F back-compat)", () => {
		// `b.channel(createWhatsAppAdapter())` (legacy boot, no opts) must
		// refuse to start when the operator has declared multiple accounts —
		// otherwise the plugin path would double-spawn the default socket.
		const legacy = createWhatsAppAdapter();
		const multiCfg = {
			channels: {
				whatsapp: {
					enabled: true,
					accounts: [{ id: "personal" }, { id: "work" }],
				},
			},
		} as unknown as BrigadeConfig;
		assert.equal(legacy.isConfigured(multiCfg), false);
		// A single-account `accounts:[{id:"default"}]` still goes through the
		// legacy boot — the plugin manager only takes over for >1 accounts.
		const singleAccountCfg = {
			channels: {
				whatsapp: { enabled: true, accounts: [{ id: "default" }] },
			},
		} as unknown as BrigadeConfig;
		assert.equal(legacy.isConfigured(singleAccountCfg), true);
	});

	it("explicit-account adapters keep their own configuration check (plugin path)", () => {
		// When the plugin path constructs a per-account adapter it passes
		// `accountId` + `authDir`; that instance always reports configured
		// (the plugin manager decides which accounts to spin up).
		const work = createWhatsAppAdapter({ accountId: "work", authDir: "/tmp/work" });
		const multiCfg = {
			channels: {
				whatsapp: {
					enabled: true,
					accounts: [{ id: "personal" }, { id: "work" }],
				},
			},
		} as unknown as BrigadeConfig;
		assert.equal(work.isConfigured(multiCfg), true);
	});

	it("refuses sendText before start()", async () => {
		const a = createWhatsAppAdapter();
		await assert.rejects(() => a.sendText("123@s.whatsapp.net", "hi"), /not started/);
	});

	it("stop() before start() is a harmless no-op", async () => {
		const a = createWhatsAppAdapter();
		await a.stop(); // must not throw even though nothing was connected
	});

	it("exposes a pairing adapter with idLabel='phone' (Lane C parity)", () => {
		// The manager reads `pairing.idLabel` to decide whether the challenge
		// card says "Your number" / "Your username" / "Your account". WhatsApp
		// ids are international phone numbers, so the slot is declared with
		// `idLabel: "phone"`. No `normalizeAllowEntry` / `notifyApproval` for
		// WhatsApp today — those land per-channel as later channels (Slack,
		// Discord) ship.
		const a = createWhatsAppAdapter();
		assert.ok(a.pairing, "WhatsApp adapter must expose a pairing slot");
		assert.equal(a.pairing?.idLabel, "phone");
	});

	it("maps opts.replyToId → connection.sendText { replyToId } (native quote)", async () => {
		const { connectImpl, sends } = makeFakeWaConnect();
		const a = createWhatsAppAdapter({ connectImpl });
		await a.start(makeWaStartCtx());
		await a.sendText("15551234567@s.whatsapp.net", "quoted reply", { replyToId: "WAMID-9" });
		const calls = sends();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.opts?.replyToId, "WAMID-9", "reply target threads into the connection");
	});

	it("back-compat: a send with NO replyToId passes undefined opts to the connection", async () => {
		const { connectImpl, sends } = makeFakeWaConnect();
		const a = createWhatsAppAdapter({ connectImpl });
		await a.start(makeWaStartCtx());
		await a.sendText("15551234567@s.whatsapp.net", "plain send");
		const calls = sends();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.opts, undefined, "no quote linkage when replyToId is absent");
		assert.equal(calls[0]?.text, "plain send");
	});
});

describe("whatsAppModule", () => {
	it("registers exactly one whatsapp channel through the seam", () => {
		const reg = new BrigadeExtensionRegistry();
		whatsAppModule.register(reg.context(META));
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.id, "whatsapp");
		// product-only: registers no tools/hooks into the Pi factory
		assert.deepEqual(reg.toolNames(), []);
	});
});
