import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	decodeGeneralCallbackData,
	GENERAL_CALLBACK_PREFIX,
	isGeneralCallbackData,
} from "../general-callback.js";
import {
	buildSlackApprovalBlocks,
	buildSlackInlineKeyboard,
	extractBlockActionPayload,
	SLACK_APPROVAL_ACTION_ID,
	SLACK_GENERAL_ACTION_ID,
} from "./blocks.js";

describe("general callback convention (slack)", () => {
	it("round-trips a token through prefix + decode", () => {
		const data = `${GENERAL_CALLBACK_PREFIX}buy`;
		assert.equal(isGeneralCallbackData(data), true);
		assert.equal(decodeGeneralCallbackData(data), "buy");
	});
});

describe("buildSlackInlineKeyboard", () => {
	it("prefixes button values and routes them to the general action_id", () => {
		const blocks = buildSlackInlineKeyboard([
			[
				{ text: "Yes", data: "yes" },
				{ text: "No", data: "no" },
			],
		]);
		assert.ok(blocks);
		assert.equal(blocks?.length, 1);
		const els = blocks?.[0]?.elements ?? [];
		assert.equal(els[0]?.text.text, "Yes");
		assert.equal(els[0]?.action_id, SLACK_GENERAL_ACTION_ID);
		assert.equal(els[0]?.value, `${GENERAL_CALLBACK_PREFIX}yes`);
		assert.equal(els[1]?.value, `${GENERAL_CALLBACK_PREFIX}no`);
	});

	it("drops a button with an empty label or data", () => {
		const blocks = buildSlackInlineKeyboard([
			[
				{ text: "", data: "x" },
				{ text: "Keep", data: "k" },
				{ text: "NoData", data: "" },
			],
		]);
		assert.equal(blocks?.[0]?.elements.length, 1);
		assert.equal(blocks?.[0]?.elements[0]?.text.text, "Keep");
	});

	it("rejects (drops) a value that overflows the 255-char budget", () => {
		const huge = "z".repeat(300);
		assert.equal(buildSlackInlineKeyboard([[{ text: "Big", data: huge }]]), null);
	});

	it("returns null for an all-empty grid", () => {
		assert.equal(buildSlackInlineKeyboard([[]]), null);
		assert.equal(buildSlackInlineKeyboard([]), null);
	});

	it("chunks more than 5 buttons into separate actions blocks", () => {
		const grid = [Array.from({ length: 7 }, (_v, i) => ({ text: `b${i}`, data: `${i}` }))];
		const blocks = buildSlackInlineKeyboard(grid);
		assert.ok(blocks);
		assert.equal(blocks?.length, 2);
		assert.equal(blocks?.[0]?.elements.length, 5);
		assert.equal(blocks?.[1]?.elements.length, 2);
	});
});

describe("buildSlackApprovalBlocks", () => {
	it("shapes codec specs into approval-action buttons with styles", () => {
		const blocks = buildSlackApprovalBlocks([
			{ label: "Allow once", data: "bv1:abc:o", decision: "allow-once" },
			{ label: "Allow always", data: "bv1:abc:a", decision: "allow-always" },
			{ label: "Deny", data: "bv1:abc:d", decision: "deny" },
		]);
		assert.equal(blocks.length, 1);
		const els = blocks[0]?.elements ?? [];
		assert.equal(els.length, 3);
		assert.equal(els[0]?.action_id, SLACK_APPROVAL_ACTION_ID);
		assert.equal(els[0]?.style, "primary");
		assert.equal(els[2]?.style, "danger");
		assert.equal(els[0]?.value, "bv1:abc:o");
	});

	it("returns [] when fewer than two buttons are usable", () => {
		assert.deepEqual(buildSlackApprovalBlocks([{ label: "Only", data: "bv1:x:o" }]), []);
	});
});

describe("extractBlockActionPayload", () => {
	it("pulls the value from a Brigade-owned action", () => {
		assert.equal(
			extractBlockActionPayload([{ action_id: SLACK_APPROVAL_ACTION_ID, value: "bv1:abc:o" }]),
			"bv1:abc:o",
		);
		assert.equal(
			extractBlockActionPayload([{ action_id: SLACK_GENERAL_ACTION_ID, value: "g:buy" }]),
			"g:buy",
		);
	});

	it("ignores foreign actions / empty values", () => {
		assert.equal(extractBlockActionPayload([{ action_id: "someone_elses", value: "x" }]), null);
		assert.equal(extractBlockActionPayload([{ action_id: SLACK_APPROVAL_ACTION_ID, value: "" }]), null);
		assert.equal(extractBlockActionPayload(undefined), null);
	});
});
