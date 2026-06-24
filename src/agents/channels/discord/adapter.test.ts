import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelStartContext, InboundMessage } from "../sdk.js";
import { createDiscordAdapter, DISCORD_CAPABILITIES, buildReactionNote, type DiscordAdapter } from "./adapter.js";
import type { ConnectDiscordArgs, DiscordConnection } from "./connection.js";

const enabledCfg = (over: Record<string, unknown> = {}): BrigadeConfig =>
	({ channels: { discord: { enabled: true, botToken: "tok-AAAAAAAAAA.bbb.ccccccccccc", ...over } } }) as unknown as BrigadeConfig;

/** Recorded calls to the fake connection's methods (for parity assertions). */
interface FakeConnCalls {
	sentText: Array<{ channel: string; text: string; threadId?: string; replyToMessageId?: string }>;
	sentInteractive: Array<{ channel: string; text: string; rows: unknown; threadId?: string }>;
	edits: Array<{ channel: string; messageId: string; text: string }>;
	deletes: Array<{ channel: string; messageId: string }>;
	reactions: Array<{ channel: string; messageId: string; emoji: string }>;
	reactionsCleared: Array<{ channel: string; messageId: string }>;
	registered: Array<unknown[]>;
}

interface FakeConnHandle {
	args: ConnectDiscordArgs;
	calls: FakeConnCalls;
}

function makeFakeConnectImpl(): {
	connectImpl: (a: ConnectDiscordArgs) => Promise<DiscordConnection>;
	handle: () => FakeConnHandle | null;
} {
	let handle: FakeConnHandle | null = null;
	const connectImpl = async (args: ConnectDiscordArgs): Promise<DiscordConnection> => {
		const state = { connected: true, tokenInvalid: false };
		const calls: FakeConnCalls = { sentText: [], sentInteractive: [], edits: [], deletes: [], reactions: [], reactionsCleared: [], registered: [] };
		let seq = 0;
		const conn: DiscordConnection = {
			selfId: () => "BOT",
			selfName: () => "brigadebot",
			connectedAt: () => 1234,
			lastEventAt: () => 5678,
			isConnected: () => state.connected,
			isTokenInvalid: () => state.tokenInvalid,
			sendText: async (channel, text, o) => {
				calls.sentText.push({ channel, text, threadId: o?.threadId, replyToMessageId: o?.replyToMessageId });
				return { messageId: `m${++seq}` };
			},
			sendInteractive: async (channel, text, rows, o) => {
				calls.sentInteractive.push({ channel, text, rows, threadId: o?.threadId });
				return { messageId: `i${++seq}` };
			},
			sendMedia: async () => {},
			react: async (channel, messageId, emoji) => {
				calls.reactions.push({ channel, messageId, emoji });
			},
			removeOwnReactions: async (channel, messageId) => {
				calls.reactionsCleared.push({ channel, messageId });
			},
			editMessageText: async (channel, messageId, text) => {
				calls.edits.push({ channel, messageId, text });
			},
			deleteMessage: async (channel, messageId) => {
				calls.deletes.push({ channel, messageId });
			},
			registerCommands: async (cmds) => {
				calls.registered.push(cmds);
			},
			setComposing: async () => {},
			markRead: async () => {},
			close: async () => {
				state.connected = false;
			},
		};
		handle = { args, calls };
		// Simulate the connection announcing readiness so the adapter flips connected.
		args.onConnected?.();
		return conn;
	};
	return { connectImpl, handle: () => handle };
}

function makeStartCtx(onInbound: (m: InboundMessage) => void): ChannelStartContext {
	return {
		onInbound: async (m) => onInbound(m),
		log: () => {},
		signal: new AbortController().signal,
	};
}

describe("createDiscordAdapter — config gating", () => {
	it("is configured when enabled + a bot token resolves", () => {
		const a = createDiscordAdapter();
		assert.equal(a.isConfigured(enabledCfg(), {}), true);
	});

	it("is NOT configured when disabled", () => {
		const a = createDiscordAdapter();
		const cfg = { channels: { discord: { enabled: false } } } as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});

	it("is NOT configured when no bot token resolves", () => {
		const a = createDiscordAdapter();
		const cfg = { channels: { discord: { enabled: true } } } as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});

	it("steps aside (legacy default) when >1 account is configured", () => {
		const a = createDiscordAdapter();
		const cfg = {
			channels: { discord: { enabled: true, accounts: [{ id: "a", botToken: "tok-a" }, { id: "b", botToken: "tok-b" }] } },
		} as unknown as BrigadeConfig;
		assert.equal(a.isConfigured(cfg, {}), false);
	});
});

describe("createDiscordAdapter — inbound + health", () => {
	it("wires onMessage → ctx.onInbound with channel + guild + roles stamped (NOT teamId)", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const received: InboundMessage[] = [];
		await a.start(makeStartCtx((m) => received.push(m)));
		assert.equal(a.health!().ok, true);
		handle()!.args.onMessage({
			conversationId: "C1",
			from: "U2",
			text: "hi",
			chatType: "group",
			guildId: "G1",
			memberRoleIds: ["R1", "R2"],
			messageId: "55",
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.equal(received[0]?.channel, "discord");
		// Discord routes on guildId + member role ids, NOT teamId (Slack's tier).
		assert.equal(received[0]?.guildId, "G1");
		assert.deepEqual(received[0]?.memberRoleIds, ["R1", "R2"]);
		assert.equal(received[0]?.teamId, undefined);
		assert.equal(received[0]?.isGroup, true);
	});

	it("registers native slash commands on connect", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		// registerCommands is called (best-effort) after onConnected fires.
		const reg = handle()!.calls.registered;
		assert.equal(reg.length, 1);
		assert.ok(Array.isArray(reg[0]));
		assert.ok((reg[0] as unknown[]).length > 0, "the bundled commands (/help, /status, …) must be registered");
	});

	it("routes a reaction as a synthesised note", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const received: InboundMessage[] = [];
		await a.start(makeStartCtx((m) => received.push(m)));
		handle()!.args.onReaction?.({
			conversationId: "C1",
			from: "U2",
			text: "",
			chatType: "group",
			reaction: { emojis: ["tada"], targetMessageId: "90" },
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.match(received[0]?.text ?? "", /reacted :tada: to message 90/);
	});

	it("routes a button press as callbackQuery", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		const received: InboundMessage[] = [];
		await a.start(makeStartCtx((m) => received.push(m)));
		handle()!.args.onCallbackQuery?.({
			conversationId: "C1",
			from: "U2",
			text: "",
			chatType: "group",
			callbackQuery: { data: "bv1:abc:o", callbackId: "i1" },
			raw: {},
		});
		assert.equal(received.length, 1);
		assert.equal(received[0]?.callbackQuery?.data, "bv1:abc:o");
	});

	it("health reports starting before start, ok after", async () => {
		const { connectImpl } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		assert.equal(a.health!().ok, false);
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		assert.equal(a.health!().ok, true);
	});
});

describe("createDiscordAdapter — outbound", () => {
	it("sendText renders Discord markup + threads the first chunk only", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		await a.sendText("C1", "hello **bold** see [d](https://e.com)", { threadId: "T1" });
		const sent = handle()!.calls.sentText;
		assert.equal(sent.length, 1);
		// Bold passes through; the link degrades to "d (url)".
		assert.equal(sent[0]?.text, "hello **bold** see d (https://e.com)");
		assert.equal(sent[0]?.threadId, "T1");
	});

	it("handleAction edit/delete/react routes to the connection", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl }) as DiscordAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		const edit = await a.handleAction!({ conversationId: "C1", action: { kind: "edit", messageId: "20", text: "new **x**" } });
		assert.equal(edit.ok, true);
		const del = await a.handleAction!({ conversationId: "C1", action: { kind: "delete", messageId: "20" } });
		assert.equal(del.ok, true);
		const react = await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "20", emoji: "tada" } });
		assert.equal(react.ok, true);
		const calls = handle()!.calls;
		assert.equal(calls.edits[0]?.text, "new **x**");
		assert.equal(calls.deletes[0]?.messageId, "20");
		assert.equal(calls.reactions[0]?.emoji, "tada");
	});

	it("handleAction react with an EMPTY emoji clears the bot's own reactions; non-empty adds", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl }) as DiscordAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		const cleared = await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "7", emoji: "" } });
		assert.equal(cleared.ok, true);
		const calls = handle()!.calls;
		assert.equal(calls.reactionsCleared.length, 1);
		assert.equal(calls.reactions.length, 0, "empty emoji must NOT add a reaction");
		await a.handleAction!({ conversationId: "C1", action: { kind: "react", messageId: "8", emoji: "tada" } });
		assert.equal(calls.reactions.length, 1);
	});

	it("handleAction buttons sends component rows", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl }) as DiscordAdapter;
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		const res = await a.handleAction!({
			conversationId: "C1",
			action: { kind: "buttons", text: "pick", buttons: [[{ text: "Yes", data: "yes" }]] },
		});
		assert.equal(res.ok, true);
		assert.equal(handle()!.calls.sentInteractive.length, 1);
	});

	it("approvalCapability sends component rows via the interactive path", async () => {
		const { connectImpl, handle } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		a.isConfigured(enabledCfg(), {});
		await a.start(makeStartCtx(() => {}));
		await a.approvalCapability!.sendApprovalPrompt!({
			runtime: {},
			cfg: enabledCfg(),
			conversationId: "C1",
			approvalId: "exec-abc",
			approvalKind: "exec",
			command: "ls",
			timeoutMs: 1000,
		});
		const inter = handle()!.calls.sentInteractive;
		assert.equal(inter.length, 1);
		assert.ok(Array.isArray(inter[0]?.rows));
	});

	it("authorizeApprover defers to the access gate when no allow-from is set", () => {
		const { connectImpl } = makeFakeConnectImpl();
		const a = createDiscordAdapter({ connectImpl });
		const verdict = a.approvalCapability!.authorizeApprover!({ cfg: enabledCfg(), senderId: "U2", action: "approve", approvalKind: "exec" });
		assert.equal(verdict.authorized, true);
	});
});

describe("DISCORD_CAPABILITIES + helpers", () => {
	it("advertises edit/unsend/react/reply/threads/media + nativeCommands (no polls)", () => {
		assert.equal(DISCORD_CAPABILITIES.edit, true);
		assert.equal(DISCORD_CAPABILITIES.unsend, true);
		assert.equal(DISCORD_CAPABILITIES.reactions, true);
		assert.equal(DISCORD_CAPABILITIES.threads, true);
		assert.equal(DISCORD_CAPABILITIES.media, true);
		assert.equal(DISCORD_CAPABILITIES.nativeCommands, true);
		assert.equal(DISCORD_CAPABILITIES.polls, undefined);
	});

	it("buildReactionNote wraps emoji names in colons (custom emoji → name only)", () => {
		assert.equal(buildReactionNote(["tada"], "90", "Sam"), "Sam reacted :tada: to message 90.");
		assert.equal(buildReactionNote(["partyblob:111"], "90", "Sam"), "Sam reacted :partyblob: to message 90.");
	});
});
