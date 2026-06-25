import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	formatIMessageChatTarget,
	inferIMessageTargetChatType,
	isAllowedIMessageSender,
	normalizeE164,
	normalizeIMessageHandle,
	parseIMessageAllowTarget,
	parseIMessageTarget,
} from "./targets.js";

describe("parseIMessageTarget", () => {
	it("parses a bare phone handle to service auto", () => {
		const t = parseIMessageTarget("+15551234567");
		assert.equal(t.kind, "handle");
		if (t.kind === "handle") {
			assert.equal(t.to, "+15551234567");
			assert.equal(t.service, "auto");
		}
	});

	it("parses a service-prefixed handle keeping the service", () => {
		const t = parseIMessageTarget("sms:+15551234567");
		assert.equal(t.kind, "handle");
		if (t.kind === "handle") {
			assert.equal(t.to, "+15551234567");
			assert.equal(t.service, "sms");
		}
	});

	it("parses chat_id to a numeric target", () => {
		const t = parseIMessageTarget("chat_id:42");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 42);
	});

	it("parses chat_guid + chat_identifier preserving case", () => {
		const g = parseIMessageTarget("chat_guid:ABC-123");
		assert.equal(g.kind, "chat_guid");
		if (g.kind === "chat_guid") assert.equal(g.chatGuid, "ABC-123");
		const i = parseIMessageTarget("chat_identifier:iMessage;-;+1555");
		assert.equal(i.kind, "chat_identifier");
		if (i.kind === "chat_identifier") assert.equal(i.chatIdentifier, "iMessage;-;+1555");
	});

	it("parses a service-prefixed chat target", () => {
		const t = parseIMessageTarget("imessage:chat_id:7");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 7);
	});

	it("throws on an empty target", () => {
		assert.throws(() => parseIMessageTarget(""), /target is required/);
	});

	it("throws on a malformed chat_id (strict)", () => {
		assert.throws(() => parseIMessageTarget("chat_id:notanumber"), /Invalid chat_id/);
	});
});

describe("normalizeIMessageHandle", () => {
	it("lowercases an email handle", () => {
		assert.equal(normalizeIMessageHandle("User@Example.COM"), "user@example.com");
	});

	it("E.164-normalizes a phone", () => {
		assert.equal(normalizeIMessageHandle("(555) 123-4567"), "+5551234567");
		assert.equal(normalizeIMessageHandle("+1 555 123 4567"), "+15551234567");
	});

	it("strips a service prefix before normalizing", () => {
		assert.equal(normalizeIMessageHandle("imessage:User@Example.com"), "user@example.com");
	});

	it("keeps a chat prefix (prefix lowercased, value verbatim)", () => {
		assert.equal(normalizeIMessageHandle("CHAT_GUID:ABC-1"), "chat_guid:ABC-1");
	});
});

describe("normalizeE164", () => {
	it("prepends + when missing", () => {
		assert.equal(normalizeE164("5551234567"), "+5551234567");
	});
	it("strips a scheme prefix", () => {
		assert.equal(normalizeE164("tel:+15551234567"), "+15551234567");
	});
});

describe("parseIMessageAllowTarget (lenient)", () => {
	it("skips a malformed chat_id rather than throwing → normalized handle", () => {
		const t = parseIMessageAllowTarget("chat_id:nope");
		assert.equal(t.kind, "handle");
	});
	it("parses a valid chat_id", () => {
		const t = parseIMessageAllowTarget("chat_id:9");
		assert.equal(t.kind, "chat_id");
		if (t.kind === "chat_id") assert.equal(t.chatId, 9);
	});
});

describe("isAllowedIMessageSender", () => {
	it("matches a normalized handle entry", () => {
		assert.equal(
			isAllowedIMessageSender({ allowFrom: ["+15551234567"], sender: "+1 (555) 123-4567" }),
			true,
		);
	});
	it("matches a chat_id entry by id", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: ["chat_id:42"], sender: "x", chatId: 42 }), true);
	});
	it("honours the wildcard", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: ["*"], sender: "anyone" }), true);
	});
	it("returns false on an empty list", () => {
		assert.equal(isAllowedIMessageSender({ allowFrom: [], sender: "x" }), false);
	});
});

describe("formatIMessageChatTarget + inferIMessageTargetChatType", () => {
	it("formats a numeric chat id", () => {
		assert.equal(formatIMessageChatTarget(5), "chat_id:5");
		assert.equal(formatIMessageChatTarget(undefined), "");
	});
	it("infers dm vs group", () => {
		assert.equal(inferIMessageTargetChatType("+15551234567"), "dm");
		assert.equal(inferIMessageTargetChatType("chat_id:5"), "group");
	});
});
