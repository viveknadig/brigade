import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Message } from "@grammyjs/types";

import {
	buildTelegramSenderName,
	extractTelegramForwardContext,
	extractTelegramMentions,
	extractTelegramNonTextBody,
	extractTelegramReplyContext,
	extractTelegramText,
	hasInboundMedia,
	resolveInboundMediaFileId,
	resolveInboundMediaKind,
	telegramChatType,
	telegramThreadId,
} from "./inbound-extras.js";

const msg = (over: Partial<Message> = {}): Message =>
	({
		message_id: 1,
		date: 1,
		chat: { id: 5, type: "private", first_name: "A" },
		from: { id: 5, is_bot: false, first_name: "A" },
		...over,
	}) as Message;

describe("extractTelegramText", () => {
	it("returns the text body trimmed", () => {
		assert.equal(extractTelegramText(msg({ text: "  hi  " })), "hi");
	});

	it("falls back to a media caption when there is no text", () => {
		assert.equal(extractTelegramText(msg({ text: undefined, caption: "a pic" } as Partial<Message>)), "a pic");
	});

	it("drops binary/control-byte payloads", () => {
		// Build the control byte programmatically — a raw NUL must never appear in source.
		const withNul = `a${String.fromCharCode(0)}b`;
		assert.equal(extractTelegramText(msg({ text: withNul })), "");
	});

	it("expands text_link entities into markdown links", () => {
		const out = extractTelegramText(
			msg({ text: "go here now", entities: [{ type: "text_link", offset: 3, length: 4, url: "https://e.com" }] }),
		);
		assert.equal(out, "go [here](https://e.com) now");
	});

	it("falls back to a location rendering when there is no text/caption", () => {
		assert.equal(extractTelegramText(msg({ location: { latitude: 1, longitude: 2 } } as Partial<Message>)), "[Location: 1, 2]");
	});

	it("prefers real text over the non-text rendering", () => {
		assert.equal(extractTelegramText(msg({ text: "look", location: { latitude: 1, longitude: 2 } } as Partial<Message>)), "look");
	});
});

describe("extractTelegramNonTextBody", () => {
	it("renders a location pin", () => {
		assert.equal(extractTelegramNonTextBody(msg({ location: { latitude: 37.77, longitude: -122.41 } } as Partial<Message>)), "[Location: 37.77, -122.41]");
	});

	it("renders a live location", () => {
		assert.equal(extractTelegramNonTextBody(msg({ location: { latitude: 1, longitude: 2, live_period: 600 } } as Partial<Message>)), "[Live location: 1, 2]");
	});

	it("renders a venue with title + address + coords", () => {
		assert.equal(
			extractTelegramNonTextBody(msg({ venue: { title: "Cafe", address: "1 Main St", location: { latitude: 1, longitude: 2 } } } as Partial<Message>)),
			"[Venue: Cafe — 1 Main St (1, 2)]",
		);
	});

	it("renders a contact", () => {
		assert.equal(
			extractTelegramNonTextBody(msg({ contact: { phone_number: "+15551234", first_name: "Jane", last_name: "Doe" } } as Partial<Message>)),
			"[Contact: Jane Doe · +15551234]",
		);
	});

	it("renders a poll question + options", () => {
		assert.equal(
			extractTelegramNonTextBody(msg({ poll: { question: "Lunch?", options: [{ text: "Pizza" }, { text: "Tacos" }] } } as Partial<Message>)),
			'[Poll: "Lunch?" — Pizza / Tacos]',
		);
	});

	it("returns empty for a plain text message", () => {
		assert.equal(extractTelegramNonTextBody(msg({ text: "hi" })), "");
	});
});

describe("telegramChatType / telegramThreadId", () => {
	it("private → direct, group/supergroup → group", () => {
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "private", first_name: "A" } as Message["chat"] })), "direct");
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "group", title: "G" } as Message["chat"] })), "group");
		assert.equal(telegramChatType(msg({ chat: { id: 1, type: "supergroup", title: "S" } as Message["chat"] })), "group");
	});

	it("threadId is the message_thread_id as a string, else undefined", () => {
		assert.equal(telegramThreadId(msg({ message_thread_id: 7 })), "7");
		assert.equal(telegramThreadId(msg({})), undefined);
	});
});

describe("extractTelegramMentions", () => {
	it("surfaces the bot id when @username is mentioned (entity)", () => {
		const m = msg({ text: "yo @brigadebot hi", entities: [{ type: "mention", offset: 3, length: 11 }] });
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("surfaces the bot id for a standalone @username with no entity", () => {
		const m = msg({ text: "ping @brigadebot" });
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("treats a reply to the bot's own message as an address", () => {
		const m = msg({
			text: "ok",
			reply_to_message: { message_id: 9, date: 1, chat: { id: 5, type: "group", title: "G" }, from: { id: 42, is_bot: true, first_name: "B" } } as Message["reply_to_message"],
		});
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["42"]);
	});

	it("surfaces a text_mention user's id (not the bot)", () => {
		const m = msg({
			text: "hey there",
			entities: [{ type: "text_mention", offset: 4, length: 5, user: { id: 99, is_bot: false, first_name: "C" } }],
		});
		assert.deepEqual(extractTelegramMentions(m, "brigadebot", "42"), ["99"]);
	});

	it("returns [] when the bot is not addressed", () => {
		assert.deepEqual(extractTelegramMentions(msg({ text: "nobody here" }), "brigadebot", "42"), []);
	});
});

describe("extractTelegramReplyContext", () => {
	it("returns undefined when not a reply", () => {
		assert.equal(extractTelegramReplyContext(msg({ text: "x" })), undefined);
	});

	it("captures id, sender, and a truncated body", () => {
		const long = "y".repeat(400);
		const m = msg({
			reply_to_message: { message_id: 33, date: 1, chat: { id: 5, type: "private", first_name: "A" }, from: { id: 7, is_bot: false, first_name: "B" }, text: long } as Message["reply_to_message"],
		});
		const ctx = extractTelegramReplyContext(m);
		assert.equal(ctx?.messageId, "33");
		assert.equal(ctx?.from, "7");
		assert.equal(ctx?.body?.length, 280);
	});

	it("prefers the user's partial-quote selection over the full quoted text", () => {
		const m = msg({
			quote: { text: "the important part" },
			reply_to_message: { message_id: 8, date: 1, chat: { id: 5, type: "private", first_name: "A" }, from: { id: 7, is_bot: false, first_name: "B" }, text: "a long original body" } as Message["reply_to_message"],
		} as Partial<Message>);
		const ctx = extractTelegramReplyContext(m);
		assert.equal(ctx?.body, "the important part");
		assert.equal(ctx?.messageId, "8");
	});

	it("appends a media marker when the quoted message was media", () => {
		const m = msg({
			reply_to_message: { message_id: 8, date: 1, chat: { id: 5, type: "private", first_name: "A" }, from: { id: 7, is_bot: false, first_name: "B" }, photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] } as Message["reply_to_message"],
		} as Partial<Message>);
		assert.equal(extractTelegramReplyContext(m)?.body, "[image]");
	});

	it("handles an external_reply that quotes a message from another chat", () => {
		const m = msg({ quote: { text: "quoted bit" }, external_reply: { origin: { type: "channel" } } } as Partial<Message>);
		const ctx = extractTelegramReplyContext(m);
		assert.equal(ctx?.messageId, undefined);
		assert.match(ctx?.body ?? "", /quoted bit/);
		assert.match(ctx?.body ?? "", /another chat/);
	});
});

describe("media detection", () => {
	it("hasInboundMedia true for photo/video/doc/sticker/voice", () => {
		assert.equal(hasInboundMedia(msg({ photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] } as Partial<Message>)), true);
		assert.equal(hasInboundMedia(msg({ document: { file_id: "d", file_unique_id: "u" } } as Partial<Message>)), true);
		assert.equal(hasInboundMedia(msg({ text: "no media" })), false);
	});

	it("resolveInboundMediaFileId picks the largest photo / single file", () => {
		const m = msg({
			photo: [
				{ file_id: "small", file_unique_id: "s", width: 90, height: 90 },
				{ file_id: "big", file_unique_id: "b", width: 800, height: 800 },
			],
		} as Partial<Message>);
		assert.equal(resolveInboundMediaFileId(m), "big");
		assert.equal(resolveInboundMediaKind(m), "image");
	});

	it("resolveInboundMediaKind classifies voice vs audio vs document", () => {
		assert.equal(resolveInboundMediaKind(msg({ voice: { file_id: "v", file_unique_id: "u", duration: 1 } } as Partial<Message>)), "voice");
		assert.equal(resolveInboundMediaKind(msg({ audio: { file_id: "a", file_unique_id: "u", duration: 1 } } as Partial<Message>)), "audio");
		assert.equal(resolveInboundMediaKind(msg({ sticker: { file_id: "s", file_unique_id: "u", width: 1, height: 1, type: "regular", is_animated: false, is_video: false } } as Partial<Message>)), "sticker");
	});
});

describe("buildTelegramSenderName", () => {
	it("prefers First Last, falls back to @username", () => {
		assert.equal(buildTelegramSenderName(msg({ from: { id: 1, is_bot: false, first_name: "Jane", last_name: "Doe" } })), "Jane Doe");
		assert.equal(buildTelegramSenderName(msg({ from: { id: 1, is_bot: false, first_name: "", username: "jd" } as Message["from"] })), "@jd");
	});
});

describe("extractTelegramForwardContext", () => {
	it("returns undefined for a non-forwarded message", () => {
		assert.equal(extractTelegramForwardContext(msg({ text: "hi" })), undefined);
	});

	it("reads a modern forward_origin user origin", () => {
		const fwd = extractTelegramForwardContext(
			msg({
				forward_origin: {
					type: "user",
					date: 1_700_000_000,
					sender_user: { id: 999, first_name: "Bob", username: "bob" },
				},
			} as Partial<Message>),
		);
		assert.equal(fwd?.senderName, "Bob");
		assert.equal(fwd?.from, "999");
		assert.equal(fwd?.date, 1_700_000_000 * 1000);
	});

	it("reads a hidden_user origin (display name only)", () => {
		const fwd = extractTelegramForwardContext(
			msg({
				forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Anon Person" },
			} as Partial<Message>),
		);
		assert.equal(fwd?.senderName, "Anon Person");
		assert.equal(fwd?.from, undefined);
	});

	it("reads a channel origin (chat title + id)", () => {
		const fwd = extractTelegramForwardContext(
			msg({
				forward_origin: {
					type: "channel",
					date: 2,
					chat: { id: -100777, title: "Announcements" },
					author_signature: "Editor",
				},
			} as Partial<Message>),
		);
		assert.equal(fwd?.chatId, "-100777");
		assert.equal(fwd?.chatTitle, "Announcements");
		assert.equal(fwd?.senderName, "Editor");
	});

	it("falls back to legacy forward_from / forward_from_chat", () => {
		const userFwd = extractTelegramForwardContext(
			msg({ forward_date: 5, forward_from: { id: 12, first_name: "Old", last_name: "Style" } } as Partial<Message>),
		);
		assert.equal(userFwd?.senderName, "Old Style");
		assert.equal(userFwd?.from, "12");

		const chatFwd = extractTelegramForwardContext(
			msg({ forward_date: 6, forward_from_chat: { id: -100888, title: "Legacy Channel" } } as Partial<Message>),
		);
		assert.equal(chatFwd?.chatId, "-100888");
		assert.equal(chatFwd?.chatTitle, "Legacy Channel");
	});
});
