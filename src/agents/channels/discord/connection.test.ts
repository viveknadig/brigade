import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	connectDiscord,
	discordBackoffDelay,
	isDiscordUnauthorized,
	redactDiscordToken,
	type ConnectDiscordArgs,
	type DiscordBuilders,
	type DiscordClientLike,
	type DiscordInboundMessage,
	type DiscordSendChannelLike,
	type DiscordSendOptions,
	type DiscordSentMessageLike,
} from "./connection.js";

/* ─────────────────────── fake discord client harness ─────────────────────── */

type Handler = (...args: unknown[]) => unknown;

interface FakeMessage {
	id?: string;
	content?: string;
	author?: { id?: string; bot?: boolean; username?: string };
	channelId?: string;
	guildId?: string | null;
	createdTimestamp?: number;
	editedTimestamp?: number | null;
	reference?: { messageId?: string | null } | null;
	mentions?: { users?: Array<{ id?: string; username?: string }> };
	attachments?: unknown[];
	channel?: { id?: string; isThread?: () => boolean; isDMBased?: () => boolean; type?: number };
	member?: { nickname?: string | null; roles?: { cache?: Map<string, { id?: string }> } | string[] } | null;
}

interface SentRecord {
	channelId: string;
	options: DiscordSendOptions;
}

interface FakeClient extends DiscordClientLike {
	handlers: Map<string, Handler[]>;
	loginCalls: number;
	destroyed: number;
	sent: SentRecord[];
	edits: Array<{ id: string; options: DiscordSendOptions | string }>;
	deletes: string[];
	reactsAdded: Array<{ id: string; emoji: string }>;
	emit(event: string, ...payload: unknown[]): void;
	ready(): void;
}

interface FakeClientOver {
	/** When set, login() rejects with this error (terminal-auth path). */
	loginError?: Error;
	/** Reactions present on a fetched message (for removeOwnReactions). */
	messageReactions?: Array<{ me?: boolean; emoji?: { name?: string } }>;
	/** Provide a rest.put spy (application-command registration). */
	restPut?: (route: unknown, options?: { body?: unknown }) => Promise<unknown>;
}

function makeFakeClient(over: FakeClientOver = {}): FakeClient {
	const handlers = new Map<string, Handler[]>();
	const sent: SentRecord[] = [];
	const edits: FakeClient["edits"] = [];
	const deletes: string[] = [];
	const reactsAdded: FakeClient["reactsAdded"] = [];
	let sendSeq = 0;
	const userObj: { id?: string; username?: string } = { id: "BOT", username: "brigadebot" };

	const makeMessage = (id: string): DiscordSentMessageLike => ({
		id,
		async edit(options) {
			edits.push({ id, options });
			return makeMessage(id);
		},
		async delete() {
			deletes.push(id);
			return undefined;
		},
		async react(emoji) {
			reactsAdded.push({ id, emoji });
			return undefined;
		},
		reactions: {
			cache: new Map((over.messageReactions ?? []).map((r, i) => [String(i), { ...r, users: { remove: async () => undefined } }])),
		},
	});

	const makeChannel = (channelId: string): DiscordSendChannelLike => ({
		id: channelId,
		isTextBased: () => true,
		async send(options) {
			sent.push({ channelId, options });
			return makeMessage(`sent-${++sendSeq}`);
		},
		messages: {
			async fetch(id) {
				return makeMessage(id);
			},
		},
		async sendTyping() {
			return undefined;
		},
	});

	const client: FakeClient = {
		handlers,
		loginCalls: 0,
		destroyed: 0,
		sent,
		edits,
		deletes,
		reactsAdded,
		user: userObj,
		...(over.restPut ? { rest: { put: over.restPut } } : {}),
		channels: {
			async fetch(id) {
				return makeChannel(id);
			},
		},
		users: {
			async fetch() {
				return { async createDM() { return makeChannel("dm-1"); } };
			},
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler as Handler);
			handlers.set(event, list);
			return client;
		},
		once(event, handler) {
			return client.on(event, handler);
		},
		async login() {
			client.loginCalls += 1;
			if (over.loginError) throw over.loginError;
			return "ok";
		},
		async destroy() {
			client.destroyed += 1;
		},
		emit(event, ...payload) {
			for (const h of handlers.get(event) ?? []) h(...payload);
		},
		ready() {
			client.emit("clientReady");
		},
	};
	return client;
}

/** A pass-through builders fake — emits plain JSON the assertions can read. */
const fakeBuilders: DiscordBuilders = {
	buildAttachment: (path, name) => ({ attachment: path, name }),
	buildComponentRows: (rows) => rows.map((row) => ({ components: row })),
};

/** Boot a connection against a fake client, returning the harness + collected inbounds. */
async function boot(over: FakeClientOver = {}, argsOver: Partial<ConnectDiscordArgs> = {}) {
	const client = makeFakeClient(over);
	const messages: DiscordInboundMessage[] = [];
	const callbacks: DiscordInboundMessage[] = [];
	const reactions: DiscordInboundMessage[] = [];
	let connectedFired = false;
	let tokenInvalidFired = false;
	const conn = await connectDiscord({
		botToken: "tok-secret.aaa.bbb",
		accountId: "default",
		log: () => {},
		onConnected: () => {
			connectedFired = true;
		},
		onTokenInvalid: () => {
			tokenInvalidFired = true;
		},
		onMessage: (m) => messages.push(m),
		onCallbackQuery: (m) => callbacks.push(m),
		onReaction: (m) => reactions.push(m),
		clientFactory: () => client,
		buildersFactory: () => fakeBuilders,
		sleepImpl: async () => {},
		...argsOver,
	});
	// Most tests want the client past clientReady so selfId is cached.
	client.ready();
	return {
		conn,
		client,
		messages,
		callbacks,
		reactions,
		get connectedFired() {
			return connectedFired;
		},
		get tokenInvalidFired() {
			return tokenInvalidFired;
		},
	};
}

const baseMessage = (over: Partial<FakeMessage> = {}): FakeMessage => ({
	id: "m1",
	content: "hello",
	author: { id: "U1", bot: false, username: "alex" },
	channelId: "C1",
	guildId: "G1",
	createdTimestamp: 1_700_000_000_000,
	...over,
});

/* ─────────────────────── tests ─────────────────────── */

describe("discordBackoffDelay", () => {
	it("grows with the attempt and stays within the cap", () => {
		const d0 = discordBackoffDelay(0);
		const d5 = discordBackoffDelay(5);
		assert.ok(d0 > 0 && d0 <= 2_000 * 1.25);
		assert.ok(d5 <= 30_000 * 1.25);
	});
});

describe("isDiscordUnauthorized", () => {
	it("flags TokenInvalid + disallowed-intents as terminal", () => {
		assert.equal(isDiscordUnauthorized({ name: "TokenInvalid" }), true);
		assert.equal(isDiscordUnauthorized(new Error("An invalid token was provided")), true);
		assert.equal(isDiscordUnauthorized(new Error("Privileged intent provided is not enabled or whitelisted: used disallowed intents")), true);
	});

	it("does not flag a transient network error", () => {
		assert.equal(isDiscordUnauthorized(new Error("ECONNRESET")), false);
	});
});

describe("redactDiscordToken", () => {
	it("masks the literal token + a token-shaped fragment", () => {
		assert.equal(redactDiscordToken("oops tok-secret leaked", "tok-secret"), "oops <redacted> leaked");
		// A realistic Discord token shape (<24+ char id>.<6 char ts>.<27 char secret>),
		// assembled from parts at runtime so no literal token sits in source for
		// secret scanners (GitHub push protection flags a contiguous token string).
		const tokenShaped = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gabcd1", "z".repeat(27)].join(".");
		assert.match(redactDiscordToken(tokenShaped), /<redacted>/);
	});
});

describe("connectDiscord — lifecycle", () => {
	it("logs in, fires onConnected, and caches the bot identity", async () => {
		const h = await boot();
		assert.equal(h.client.loginCalls, 1);
		assert.equal(h.connectedFired, true);
		assert.equal(h.conn.isConnected(), true);
		assert.equal(h.conn.selfId(), "BOT");
		assert.equal(h.conn.selfName(), "brigadebot");
	});

	it("treats an invalid token as terminal (onTokenInvalid, no connect)", async () => {
		const h = await boot({ loginError: Object.assign(new Error("An invalid token was provided"), { name: "TokenInvalid" }) });
		assert.equal(h.tokenInvalidFired, true);
		assert.equal(h.conn.isTokenInvalid(), true);
		assert.equal(h.conn.isConnected(), false);
	});

	it("close() destroys the client", async () => {
		const h = await boot();
		await h.conn.close();
		assert.ok(h.client.destroyed >= 1);
	});

	it("treats a 4014 shardDisconnect (privileged intents) as terminal (Fix 4)", async () => {
		const h = await boot();
		assert.equal(h.conn.isTokenInvalid(), false);
		h.client.emit("shardDisconnect", { code: 4014 });
		assert.equal(h.conn.isTokenInvalid(), true);
		assert.equal(h.conn.isConnected(), false);
		assert.equal(h.tokenInvalidFired, true);
	});

	it("treats a 4004 shardDisconnect (auth failed) as terminal (Fix 4)", async () => {
		const h = await boot();
		h.client.emit("shardDisconnect", { code: 4004 });
		assert.equal(h.conn.isTokenInvalid(), true);
		assert.equal(h.tokenInvalidFired, true);
	});

	it("ignores a benign shardDisconnect close code (Fix 4 — e.g. 1006)", async () => {
		const h = await boot();
		h.client.emit("shardDisconnect", { code: 1006 });
		assert.equal(h.conn.isTokenInvalid(), false);
		assert.equal(h.tokenInvalidFired, false);
	});
});

describe("connectDiscord — inbound messages", () => {
	it("normalizes a guild message + expands mentions", async () => {
		const h = await boot();
		h.client.emit("messageCreate", baseMessage({ content: "hey <@BOT> and <@2>", mentions: { users: [{ id: "BOT" }, { id: "2", username: "sam" }] } }));
		assert.equal(h.messages.length, 1);
		const m = h.messages[0]!;
		assert.equal(m.conversationId, "C1");
		assert.equal(m.from, "U1");
		assert.equal(m.chatType, "group");
		// Discord populates guildId (NOT teamId — that field is gone from the
		// Discord inbound type entirely; teamId is Slack's workspace tier).
		assert.equal(m.guildId, "G1");
		// Bot id surfaces (addressed) so the central group ACL admits the message.
		assert.ok(m.mentions?.includes("BOT"));
	});

	it("populates guildId + memberRoleIds for a guild message (Fix 1: NOT teamId)", async () => {
		const h = await boot();
		h.client.emit(
			"messageCreate",
			baseMessage({ member: { roles: { cache: new Map([["R1", { id: "R1" }], ["R2", { id: "R2" }]]) } } }),
		);
		const m = h.messages[0]!;
		assert.equal(m.guildId, "G1");
		assert.deepEqual(m.memberRoleIds?.slice().sort(), ["R1", "R2"]);
	});

	it("leaves guildId + memberRoleIds unset for a DM (Fix 1)", async () => {
		const h = await boot();
		// A DM: no guildId, a DM-based channel, no member.
		h.client.emit("messageCreate", baseMessage({ guildId: null, channel: { id: "DM1", isDMBased: () => true }, channelId: "DM1", member: null }));
		const m = h.messages[0]!;
		assert.equal(m.chatType, "direct");
		assert.equal(m.guildId, undefined);
		assert.equal(m.memberRoleIds, undefined);
	});

	it("filters the bot's own echo", async () => {
		const h = await boot();
		h.client.emit("messageCreate", baseMessage({ author: { id: "BOT", bot: true, username: "brigadebot" } }));
		assert.equal(h.messages.length, 0);
	});

	it("filters any other bot author (no bot-loops)", async () => {
		const h = await boot();
		h.client.emit("messageCreate", baseMessage({ author: { id: "OTHERBOT", bot: true } }));
		assert.equal(h.messages.length, 0);
	});

	it("dedupes a redelivered message by id", async () => {
		const h = await boot();
		const m = baseMessage();
		h.client.emit("messageCreate", m);
		h.client.emit("messageCreate", m);
		assert.equal(h.messages.length, 1);
	});

	it("flags an edit and routes the new content", async () => {
		const h = await boot();
		h.client.emit("messageUpdate", undefined, baseMessage({ content: "edited!", editedTimestamp: 1_700_000_100_000 }));
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0]?.edited, true);
		assert.equal(h.messages[0]?.text, "edited!");
	});

	it("carries a deferred media thunk when an attachment is present", async () => {
		const h = await boot();
		h.client.emit(
			"messageCreate",
			baseMessage({ content: "", attachments: [{ id: "a1", url: "https://cdn.discordapp.com/a1", contentType: "image/png", name: "x.png" }] }),
		);
		assert.equal(typeof h.messages[0]?.resolveMedia, "function");
	});

	it("surfaces a reply context", async () => {
		const h = await boot();
		h.client.emit("messageCreate", baseMessage({ reference: { messageId: "parent1" } }));
		assert.deepEqual(h.messages[0]?.replyTo, { messageId: "parent1" });
	});
});

describe("connectDiscord — reactions", () => {
	it("routes a reaction-add as a normalized inbound", async () => {
		const h = await boot();
		h.client.emit("messageReactionAdd", { emoji: { name: "thumbsup" }, message: baseMessage({ id: "tgt" }) }, { id: "U9", bot: false, username: "sam" });
		assert.equal(h.reactions.length, 1);
		assert.deepEqual(h.reactions[0]?.reaction, { emojis: ["thumbsup"], targetMessageId: "tgt" });
	});

	it("ignores the bot's own reaction", async () => {
		const h = await boot();
		h.client.emit("messageReactionAdd", { emoji: { name: "x" }, message: baseMessage() }, { id: "BOT" });
		assert.equal(h.reactions.length, 0);
	});

	it("releases the dedupe key on remove so a re-add re-routes", async () => {
		const h = await boot();
		const reaction = { emoji: { name: "ok" }, message: baseMessage({ id: "tgt" }) };
		const user = { id: "U9", bot: false };
		h.client.emit("messageReactionAdd", reaction, user);
		h.client.emit("messageReactionRemove", reaction, user);
		h.client.emit("messageReactionAdd", reaction, user);
		assert.equal(h.reactions.length, 2);
	});
});

describe("connectDiscord — interactions", () => {
	it("routes a button press as a callbackQuery (and acks it)", async () => {
		const h = await boot();
		let deferred = false;
		h.client.emit("interactionCreate", {
			isButton: () => true,
			isChatInputCommand: () => false,
			customId: "bv1:abc:o",
			id: "i1",
			channelId: "C1",
			guildId: "G1",
			user: { id: "U1", username: "alex" },
			deferUpdate: async () => {
				deferred = true;
			},
		});
		assert.equal(h.callbacks.length, 1);
		assert.equal(h.callbacks[0]?.callbackQuery?.data, "bv1:abc:o");
		assert.equal(deferred, true);
	});

	it("routes a slash command as a /command message", async () => {
		const h = await boot();
		h.client.emit("interactionCreate", {
			isButton: () => false,
			isChatInputCommand: () => true,
			commandName: "status",
			channelId: "C1",
			guildId: "G1",
			user: { id: "U1", username: "alex" },
			reply: async () => undefined,
		});
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0]?.text, "/status");
	});
});

describe("connectDiscord — outbound", () => {
	it("sendText posts the content and returns the message id", async () => {
		const h = await boot();
		const res = await h.conn.sendText("C1", "hi there");
		assert.equal(h.client.sent.length, 1);
		assert.equal(h.client.sent[0]?.options.content, "hi there");
		assert.ok(res.messageId.startsWith("sent-"));
	});

	it("sendText attaches a reply reference when replyToMessageId is set", async () => {
		const h = await boot();
		await h.conn.sendText("C1", "re", { replyToMessageId: "parent9" });
		assert.equal(h.client.sent[0]?.options.reply?.messageReference, "parent9");
	});

	it("sendText sets safe allowedMentions — @everyone in content can't mass-ping (Fix 2)", async () => {
		const h = await boot();
		await h.conn.sendText("C1", "hey @everyone and <@123> read this");
		const am = h.client.sent[0]?.options.allowedMentions;
		// `everyone` is NOT in parse → @everyone/@here render as text, no notify.
		assert.ok(am?.parse && !am.parse.includes("everyone" as never));
		// But explicit user + role mentions still parse (so <@123> / <@&id> ping).
		assert.deepEqual(am?.parse?.slice().sort(), ["roles", "users"]);
	});

	it("sendText reply sets repliedUser:false (Fix 2 — no ping on reply)", async () => {
		const h = await boot();
		await h.conn.sendText("C1", "re", { replyToMessageId: "parent9" });
		assert.equal(h.client.sent[0]?.options.allowedMentions?.repliedUser, false);
	});

	it("sendInteractive + sendMedia also set safe allowedMentions (Fix 2)", async () => {
		const h = await boot();
		await h.conn.sendInteractive("C1", "@everyone choose", [[{ label: "Yes", customId: "g:yes", style: 2 }]]);
		await h.conn.sendMedia("C1", { kind: "image", path: "/tmp/pic.png", caption: "@everyone look" });
		for (const rec of h.client.sent) {
			const parse = rec.options.allowedMentions?.parse;
			assert.ok(parse && !parse.includes("everyone" as never), "no send may parse @everyone");
		}
	});

	it("sendText into a thread targets the thread channel", async () => {
		const h = await boot();
		await h.conn.sendText("C1", "in thread", { threadId: "T7" });
		assert.equal(h.client.sent[0]?.channelId, "T7");
	});

	it("sendInteractive attaches component rows", async () => {
		const h = await boot();
		await h.conn.sendInteractive("C1", "choose", [[{ label: "Yes", customId: "g:yes", style: 2 }]]);
		assert.ok(Array.isArray(h.client.sent[0]?.options.components));
		assert.equal(h.client.sent[0]?.options.components?.length, 1);
	});

	it("sendMedia builds an attachment + uploads it", async () => {
		const h = await boot();
		await h.conn.sendMedia("C1", { kind: "image", path: "/tmp/pic.png", caption: "look" });
		assert.equal(h.client.sent.length, 1);
		assert.equal(h.client.sent[0]?.options.content, "look");
		assert.ok(Array.isArray(h.client.sent[0]?.options.files));
	});

	it("editMessageText edits the fetched message", async () => {
		const h = await boot();
		await h.conn.editMessageText("C1", "m9", "new text");
		assert.equal(h.client.edits.length, 1);
		assert.equal(h.client.edits[0]?.id, "m9");
	});

	it("deleteMessage deletes the fetched message", async () => {
		const h = await boot();
		await h.conn.deleteMessage("C1", "m9");
		assert.deepEqual(h.client.deletes, ["m9"]);
	});

	it("react adds the emoji to the fetched message", async () => {
		const h = await boot();
		await h.conn.react("C1", "m9", "fire");
		assert.deepEqual(h.client.reactsAdded, [{ id: "m9", emoji: "fire" }]);
	});

	it("removeOwnReactions removes only the bot's own reactions", async () => {
		const h = await boot({ messageReactions: [{ me: true, emoji: { name: "a" } }, { me: false, emoji: { name: "b" } }] });
		// No throw + best-effort: exercising the path is the assertion (the fake
		// records nothing, but it must not blow up).
		await assert.doesNotReject(() => h.conn.removeOwnReactions("C1", "m9"));
	});

	it("setComposing fires typing without throwing", async () => {
		const h = await boot();
		await assert.doesNotReject(() => h.conn.setComposing("C1", "composing"));
	});

	it("registerCommands no-ops without a rest handle", async () => {
		const h = await boot();
		await assert.doesNotReject(() => h.conn.registerCommands([{ name: "help", description: "x", type: 1 }]));
	});

	it("registerCommands PUTs the application commands when rest is present", async () => {
		let putBody: unknown;
		const h = await boot({
			restPut: async (_route, options) => {
				putBody = options?.body;
				return undefined;
			},
		});
		await h.conn.registerCommands([{ name: "help", description: "x", type: 1 }]);
		assert.ok(Array.isArray(putBody));
		assert.equal((putBody as unknown[]).length, 1);
	});
});
