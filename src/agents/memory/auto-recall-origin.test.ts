import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveAutoRecallOrigin } from "./auto-recall.js";

/**
 * Regression test for the auto-recall fail-OPEN the dual-mode audit found:
 * a non-owner turn with no channel route used to fall back to `{kind:"owner"}`,
 * which would surface the operator's private facts into a stranger's pre-model
 * context. The fix makes that case return `undefined` (skip auto-recall).
 */
describe("resolveAutoRecallOrigin — auto-recall fails CLOSED for an unidentified peer", () => {
	it("owner turn → owner scope", () => {
		assert.deepEqual(resolveAutoRecallOrigin({ senderIsOwner: true, sessionKey: "s" }), { kind: "owner" });
	});

	it("channel-routed peer → their own session scope (channel + accountId)", () => {
		assert.deepEqual(
			resolveAutoRecallOrigin({
				senderIsOwner: false,
				channelApprovalRoute: { channelId: "wa", conversationId: "c1", accountId: "a1" },
				sessionKey: "s1",
			}),
			{ kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1", accountId: "a1" },
		);
	});

	it("channel route without accountId → omits accountId", () => {
		assert.deepEqual(
			resolveAutoRecallOrigin({
				senderIsOwner: false,
				channelApprovalRoute: { channelId: "wa", conversationId: "c1" },
				sessionKey: "s1",
			}),
			{ kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" },
		);
	});

	it("owner turn WITH a channel route present → owner scope wins (precedence)", () => {
		assert.deepEqual(
			resolveAutoRecallOrigin({
				senderIsOwner: true,
				channelApprovalRoute: { channelId: "wa", conversationId: "c1", accountId: "a1" },
				sessionKey: "s",
			}),
			{ kind: "owner" },
		);
	});

	it("NON-owner turn with NO channel route → undefined (SKIP — never the operator's facts)", () => {
		assert.equal(resolveAutoRecallOrigin({ senderIsOwner: false, sessionKey: "s" }), undefined);
	});
});
