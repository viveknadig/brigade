import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isDiscordUserMessageType, resolveDiscordSystemEvent } from "./system-events.js";

describe("isDiscordUserMessageType", () => {
	it("treats Default (0) and Reply (19) as user content", () => {
		assert.equal(isDiscordUserMessageType(0), true);
		assert.equal(isDiscordUserMessageType(19), true);
	});
	it("treats a system type (e.g. UserJoin=7, pin=6, boost=8) as NOT user content", () => {
		assert.equal(isDiscordUserMessageType(7), false);
		assert.equal(isDiscordUserMessageType(6), false);
		assert.equal(isDiscordUserMessageType(8), false);
	});
	it("treats an absent type as user content (a fake / partial)", () => {
		assert.equal(isDiscordUserMessageType(undefined), true);
	});
});

describe("resolveDiscordSystemEvent (Fix 1c)", () => {
	it("maps a UserJoin (7) to a concise note with actor + location", () => {
		const note = resolveDiscordSystemEvent({ type: 7, author: { id: "U1", username: "sam" } }, "C9");
		assert.equal(note, "Discord system: sam joined the server in C9");
	});
	it("maps a pin (6) and a boost (8)", () => {
		assert.match(resolveDiscordSystemEvent({ type: 6, author: { username: "ana" } }, "C1") ?? "", /pinned a message/);
		assert.match(resolveDiscordSystemEvent({ type: 8, author: { username: "ana" } }, "C1") ?? "", /boosted the server/);
	});
	it("maps a thread-created (18)", () => {
		assert.match(resolveDiscordSystemEvent({ type: 18, author: { username: "ana" } }, "C1") ?? "", /created a thread/);
	});
	it("returns null for a Default (0) / Reply (19) message", () => {
		assert.equal(resolveDiscordSystemEvent({ type: 0, author: { username: "x" } }, "C1"), null);
		assert.equal(resolveDiscordSystemEvent({ type: 19, author: { username: "x" } }, "C1"), null);
	});
	it("returns null for an unmapped system type", () => {
		assert.equal(resolveDiscordSystemEvent({ type: 9999, author: { username: "x" } }, "C1"), null);
	});
	it("omits the actor when no author resolves", () => {
		assert.equal(resolveDiscordSystemEvent({ type: 7 }, "C1"), "Discord system: joined the server in C1");
	});
});
