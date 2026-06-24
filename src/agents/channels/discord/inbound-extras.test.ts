import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildDiscordSenderName,
	discordChannelType,
	discordThreadId,
	expandDiscordTokens,
	extractDiscordMemberRoleIds,
	extractDiscordMentions,
	extractDiscordReplyContext,
	extractDiscordText,
	hasInboundMedia,
	isDmChannel,
	isThreadChannel,
	resolveDiscordAttachmentKind,
	resolveInboundAttachments,
	type DiscordAttachmentLike,
	type DiscordMessageLike,
} from "./inbound-extras.js";

const msg = (over: Partial<DiscordMessageLike> = {}): DiscordMessageLike =>
	({ id: "m1", content: "hi", author: { id: "U1", username: "alex" }, channelId: "C1", guildId: "G1", ...over });

describe("expandDiscordTokens", () => {
	it("expands a bare user mention to @id (no resolver)", () => {
		assert.equal(expandDiscordTokens("hi <@123>"), "hi @123");
		assert.equal(expandDiscordTokens("hi <@!123>"), "hi @123");
	});

	it("resolves a user mention via the resolver", () => {
		assert.equal(expandDiscordTokens("hi <@123>", { user: (id) => (id === "123" ? "Alex" : undefined) }), "hi @Alex");
	});

	it("expands a channel mention", () => {
		assert.equal(expandDiscordTokens("see <#789>"), "see #789");
		assert.equal(expandDiscordTokens("see <#789>", { channel: () => "general" }), "see #general");
	});

	it("expands a role mention", () => {
		assert.equal(expandDiscordTokens("cc <@&456>"), "cc @&456");
		assert.equal(expandDiscordTokens("cc <@&456>", { role: () => "ops" }), "cc @ops");
	});

	it("expands a custom / animated emoji token to its shortcode", () => {
		assert.equal(expandDiscordTokens("nice <:partyblob:111>"), "nice :partyblob:");
		assert.equal(expandDiscordTokens("nice <a:spin:222>"), "nice :spin:");
	});
});

describe("extractDiscordText", () => {
	it("expands tokens to readable text", () => {
		assert.equal(extractDiscordText(msg({ content: "yo <@9> and <#5>" }), { user: () => "Sam", channel: () => "gen" }), "yo @Sam and #gen");
	});

	it("drops binary / control-byte payloads", () => {
		const withNul = `a${String.fromCharCode(0)}b`;
		assert.equal(extractDiscordText(msg({ content: withNul })), "");
	});

	it("returns empty string for empty content", () => {
		assert.equal(extractDiscordText(msg({ content: "" })), "");
	});
});

describe("discord chat type + thread detection", () => {
	it("uses isDMBased()/isThread() when present", () => {
		assert.equal(isDmChannel({ isDMBased: () => true }), true);
		assert.equal(isThreadChannel({ isThread: () => true }), true);
	});

	it("falls back to the channel type enum", () => {
		assert.equal(isDmChannel({ type: 1 }), true);
		assert.equal(isThreadChannel({ type: 11 }), true);
		assert.equal(isThreadChannel({ type: 0 }), false);
	});

	it("maps a DM channel → direct and a guild channel/thread → group", () => {
		assert.equal(discordChannelType(msg({ channel: { type: 1, isDMBased: () => true } })), "direct");
		assert.equal(discordChannelType(msg({ channel: { type: 0 } })), "group");
		assert.equal(discordChannelType(msg({ channel: { type: 11, isThread: () => true } })), "group");
	});

	it("infers DM from a missing guildId when no channel object", () => {
		assert.equal(discordChannelType({ guildId: null }), "direct");
		assert.equal(discordChannelType({ guildId: "G1" }), "group");
	});
});

describe("discordThreadId", () => {
	it("returns the thread channel id when in a thread", () => {
		assert.equal(discordThreadId(msg({ channelId: "T9", channel: { id: "T9", isThread: () => true } })), "T9");
	});

	it("returns undefined for a non-thread channel", () => {
		assert.equal(discordThreadId(msg({ channel: { id: "C1", type: 0 } })), undefined);
	});
});

describe("extractDiscordMentions", () => {
	// Discord ids are numeric snowflakes, so the token scan `<@id>` only matches
	// digits; tests use realistic numeric ids.
	it("surfaces the bot id when the bot is @-mentioned (token scan)", () => {
		assert.deepEqual(extractDiscordMentions(msg({ content: "hey <@111> help" }), "111"), ["111"]);
		// The `<@!id>` nickname-mention form is also matched.
		assert.deepEqual(extractDiscordMentions(msg({ content: "hey <@!111>" }), "111"), ["111"]);
	});

	it("surfaces the bot id from the resolved mentions collection", () => {
		const m = msg({ content: "hi", mentions: { users: [{ id: "111" }] } });
		assert.deepEqual(extractDiscordMentions(m, "111"), ["111"]);
	});

	it("surfaces other user mentions but not the bot when unaddressed", () => {
		assert.deepEqual(extractDiscordMentions(msg({ content: "cc <@2> <@3>" }), "111"), ["2", "3"]);
	});

	it("unions + dedupes the collection and the token scan", () => {
		const m = msg({ content: "cc <@2>", mentions: { users: [{ id: "2" }, { id: "4" }] } });
		assert.deepEqual(extractDiscordMentions(m, "111").sort(), ["2", "4"]);
	});

	it("returns [] when nobody is mentioned", () => {
		assert.deepEqual(extractDiscordMentions(msg({ content: "just talking" }), "111"), []);
	});
});

describe("extractDiscordReplyContext", () => {
	it("returns the replied-to message id", () => {
		assert.deepEqual(extractDiscordReplyContext({ reference: { messageId: "parent1" } }), { messageId: "parent1" });
	});

	it("returns undefined for a non-reply", () => {
		assert.equal(extractDiscordReplyContext({ reference: null }), undefined);
		assert.equal(extractDiscordReplyContext({}), undefined);
	});
});

describe("extractDiscordMemberRoleIds", () => {
	it("reads role ids from a GuildMemberRoleManager .cache Collection (Map keyed by id)", () => {
		const m = msg({ member: { roles: { cache: new Map([["R1", { id: "R1" }], ["R2", { id: "R2" }]]) } } });
		assert.deepEqual(extractDiscordMemberRoleIds(m).sort(), ["R1", "R2"]);
	});

	it("reads role ids from a plain string array (a fake / partial)", () => {
		const m = msg({ member: { roles: ["R3", "R4"] } });
		assert.deepEqual(extractDiscordMemberRoleIds(m), ["R3", "R4"]);
	});

	it("reads role ids from a [key,value]-pair iterable (Collection-like, non-Map)", () => {
		const pairs: Array<[string, { id?: string }]> = [["R5", { id: "R5" }], ["R6", { id: "R6" }]];
		const m = msg({ member: { roles: { cache: pairs[Symbol.iterator]() } } });
		assert.deepEqual(extractDiscordMemberRoleIds(m).sort(), ["R5", "R6"]);
	});

	it("dedupes repeated ids", () => {
		const m = msg({ member: { roles: ["R1", "R1", "R2"] } });
		assert.deepEqual(extractDiscordMemberRoleIds(m), ["R1", "R2"]);
	});

	it("returns [] for a DM / no member / no roles", () => {
		assert.deepEqual(extractDiscordMemberRoleIds({ member: null }), []);
		assert.deepEqual(extractDiscordMemberRoleIds({}), []);
		assert.deepEqual(extractDiscordMemberRoleIds({ member: { roles: { cache: new Map() } } }), []);
	});
});

describe("buildDiscordSenderName", () => {
	it("prefers a guild nickname, then display name, then username, then id", () => {
		assert.equal(buildDiscordSenderName(msg({ member: { nickname: "Nick" }, author: { id: "U7", username: "alex" } })), "Nick");
		assert.equal(buildDiscordSenderName(msg({ author: { id: "U7", username: "alex", globalName: "Alex G" } })), "Alex G");
		assert.equal(buildDiscordSenderName(msg({ author: { id: "U7", username: "alex" } })), "alex");
		assert.equal(buildDiscordSenderName(msg({ author: { id: "U7" } })), "U7");
	});
});

describe("discord media detection", () => {
	const att = (over: Partial<DiscordAttachmentLike> = {}): DiscordAttachmentLike =>
		({ id: "a1", url: "https://cdn.discordapp.com/a1", contentType: "image/png", name: "x.png", ...over });

	it("detects a downloadable attachment", () => {
		assert.equal(hasInboundMedia(msg({ attachments: [att()] })), true);
		assert.equal(hasInboundMedia(msg({ attachments: [] })), false);
	});

	it("works with a Map (discord.js Collection) of attachments", () => {
		const coll = new Map([["a1", att()]]);
		assert.equal(hasInboundMedia(msg({ attachments: coll })), true);
		assert.deepEqual(resolveInboundAttachments(msg({ attachments: coll })).length, 1);
	});

	it("maps content types to media kinds", () => {
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "image/png", name: "x.png" })), "image");
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "video/mp4", name: "x.mp4" })), "video");
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "audio/mpeg", name: "x.mp3" })), "audio");
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "application/pdf", name: "x.pdf" })), "document");
	});

	it("treats a voice-flagged attachment as voice", () => {
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "audio/ogg", name: "voice.ogg", flags: 1 << 13 })), "voice");
		assert.equal(resolveDiscordAttachmentKind(att({ contentType: "audio/ogg", name: "voice.ogg", flags: { has: (b) => b === (1 << 13) } })), "voice");
	});
});
