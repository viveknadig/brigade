/**
 * Per-group / per-sender tool policy resolution (Fix 3 — central).
 *
 * NO channel previously resolved per-group `tools`/`toolsBySender` in Brigade, so
 * this is the central implementation. These tests cover the resolution order
 * (sender override > group tools > default-group sender > default-group tools)
 * plus the iMessage wiring scenario: a group configured to restrict tools resolves
 * a policy, while an unconfigured group resolves nothing (unchanged).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveChannelGroupToolsPolicy, resolveToolsBySender } from "./group-tool-policy.js";

describe("resolveToolsBySender", () => {
	it("matches a typed id key", () => {
		const out = resolveToolsBySender({
			toolsBySender: { "id:+1555": { deny: ["exec"] } },
			senderId: "+1555",
		});
		assert.deepEqual(out, { deny: ["exec"] });
	});

	it("matches an e164 / username / name key", () => {
		assert.deepEqual(
			resolveToolsBySender({ toolsBySender: { "e164:+15551234567": { allow: ["read"] } }, senderE164: "+15551234567" }),
			{ allow: ["read"] },
		);
		assert.deepEqual(
			resolveToolsBySender({ toolsBySender: { "username:@alice": { allow: ["web_search"] } }, senderUsername: "alice" }),
			{ allow: ["web_search"] },
		);
		assert.deepEqual(
			resolveToolsBySender({ toolsBySender: { "name:Alice": { deny: ["write"] } }, senderName: "alice" }),
			{ deny: ["write"] },
		);
	});

	it("falls back to a wildcard entry", () => {
		const out = resolveToolsBySender({
			toolsBySender: { "id:someone-else": { allow: ["read"] }, "*": { deny: ["exec"] } },
			senderId: "+1999",
		});
		assert.deepEqual(out, { deny: ["exec"] });
	});

	it("treats a legacy untyped key as an id match", () => {
		const out = resolveToolsBySender({ toolsBySender: { "+1555": { deny: ["exec"] } }, senderId: "+1555" });
		assert.deepEqual(out, { deny: ["exec"] });
	});

	it("returns undefined when no sender matches and no wildcard", () => {
		assert.equal(resolveToolsBySender({ toolsBySender: { "id:other": { deny: ["x"] } }, senderId: "+1555" }), undefined);
		assert.equal(resolveToolsBySender({ senderId: "+1555" }), undefined);
	});
});

describe("resolveChannelGroupToolsPolicy", () => {
	const cfg = {
		channels: {
			imessage: {
				groups: {
					"chat:42": {
						tools: { deny: ["exec"] },
						toolsBySender: { "id:+1trusted": { allow: ["read", "exec"] } },
					},
					"*": { tools: { allow: ["read"] } },
				},
			},
		},
	};

	it("a restricted group resolves its tool policy", () => {
		const out = resolveChannelGroupToolsPolicy({
			cfg,
			channel: "imessage",
			groupId: "chat:42",
			senderId: "+1999",
		});
		assert.deepEqual(out, { deny: ["exec"] });
	});

	it("a per-sender override inside the group wins over the group tools", () => {
		const out = resolveChannelGroupToolsPolicy({
			cfg,
			channel: "imessage",
			groupId: "chat:42",
			senderId: "+1trusted",
		});
		assert.deepEqual(out, { allow: ["read", "exec"] });
	});

	it("an unconfigured group falls back to the default (*) group policy", () => {
		const out = resolveChannelGroupToolsPolicy({
			cfg,
			channel: "imessage",
			groupId: "chat:999",
			senderId: "+1999",
		});
		assert.deepEqual(out, { allow: ["read"] });
	});

	it("returns undefined when the channel has no groups config (unchanged behaviour)", () => {
		assert.equal(
			resolveChannelGroupToolsPolicy({
				cfg: { channels: { imessage: { enabled: true } } },
				channel: "imessage",
				groupId: "chat:42",
				senderId: "+1999",
			}),
			undefined,
		);
	});

	it("reads a per-account groups block when accountId is given", () => {
		const acctCfg = {
			channels: {
				imessage: {
					accounts: [{ id: "work", groups: { "chat:7": { tools: { deny: ["web_search"] } } } }],
					groups: { "chat:7": { tools: { allow: ["everything"] } } },
				},
			},
		};
		assert.deepEqual(
			resolveChannelGroupToolsPolicy({ cfg: acctCfg, channel: "imessage", groupId: "chat:7", accountId: "work" }),
			{ deny: ["web_search"] },
		);
		// The default account still reads the channel-wide groups.
		assert.deepEqual(
			resolveChannelGroupToolsPolicy({ cfg: acctCfg, channel: "imessage", groupId: "chat:7" }),
			{ allow: ["everything"] },
		);
	});
});
