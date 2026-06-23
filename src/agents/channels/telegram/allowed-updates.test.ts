import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";

describe("resolveTelegramAllowedUpdates", () => {
	it("requests the full parity set by default (message + callback_query + reaction + edit + channel_post)", () => {
		assert.deepEqual(resolveTelegramAllowedUpdates(), [
			"message",
			"callback_query",
			"message_reaction",
			"edited_message",
			"channel_post",
		]);
	});

	it("drops message_reaction only when reactions is explicitly disabled", () => {
		assert.ok(resolveTelegramAllowedUpdates().includes("message_reaction"));
		assert.ok(!resolveTelegramAllowedUpdates({ reactions: false }).includes("message_reaction"));
	});

	it("drops edited_message only when editedMessages is explicitly disabled", () => {
		assert.ok(resolveTelegramAllowedUpdates().includes("edited_message"));
		assert.ok(!resolveTelegramAllowedUpdates({ editedMessages: false }).includes("edited_message"));
	});

	it("drops channel_post only when channelPosts is explicitly disabled", () => {
		assert.ok(resolveTelegramAllowedUpdates().includes("channel_post"));
		assert.ok(!resolveTelegramAllowedUpdates({ channelPosts: false }).includes("channel_post"));
	});

	it("is deduped + stable order with all kinds opted out except the base set", () => {
		assert.deepEqual(
			resolveTelegramAllowedUpdates({ reactions: false, editedMessages: false, channelPosts: false }),
			["message", "callback_query"],
		);
	});

	it("callback_query is present so inline-button approvals are deliverable", () => {
		assert.ok(resolveTelegramAllowedUpdates().includes("callback_query"));
	});
});
