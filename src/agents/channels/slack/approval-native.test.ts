import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildSlackApprovalMessage,
	buildSlackApprovalText,
	parseSlackApprovalAction,
} from "./approval-native.js";
import { SLACK_APPROVAL_ACTION_ID } from "./blocks.js";

describe("buildSlackApprovalMessage", () => {
	it("builds a section + actions block whose buttons decode back to the id", () => {
		const msg = buildSlackApprovalMessage({
			approvalId: "exec-abc-123",
			command: "ls -la",
			approvalKind: "exec",
		});
		assert.ok(msg, "message must be built for a normal approval id");
		// First block is the prompt section; the rest are actions.
		assert.equal(msg!.blocks[0]?.type, "section");
		const actionBlock = msg!.blocks.find((b) => b.type === "actions");
		assert.ok(actionBlock && actionBlock.type === "actions");
		const els = actionBlock.elements;
		assert.equal(els.length, 3);
		assert.deepEqual(els.map((e) => e.text.text), ["Allow once", "Allow always", "Deny"]);
		// Each button round-trips through the parse helper to the SAME id.
		const parsed = parseSlackApprovalAction([{ action_id: SLACK_APPROVAL_ACTION_ID, value: els[0]!.value }]);
		assert.equal(parsed?.approvalId, "exec-abc-123");
		assert.equal(parsed?.decision, "allow-once");
	});

	it("drops the Allow always button when allowAlways=false", () => {
		const msg = buildSlackApprovalMessage({
			approvalId: "x",
			command: "do thing",
			approvalKind: "exec",
			allowAlways: false,
		});
		assert.ok(msg);
		const actionBlock = msg!.blocks.find((b) => b.type === "actions");
		assert.ok(actionBlock && actionBlock.type === "actions");
		assert.deepEqual(actionBlock.elements.map((e) => e.text.text), ["Allow once", "Deny"]);
	});

	it("returns null when the approval id is too long for byte-safe buttons", () => {
		const msg = buildSlackApprovalMessage({
			approvalId: "z".repeat(200),
			command: "x",
			approvalKind: "exec",
		});
		assert.equal(msg, null, "caller falls back to the text prompt");
	});
});

describe("buildSlackApprovalText", () => {
	it("includes the command preview + a brand mark, control-char scrubbed", () => {
		const text = buildSlackApprovalText({ command: "rm -rf /tmp/x\nthen more", approvalKind: "exec" });
		assert.match(text, /Brigade/);
		assert.match(text, /rm -rf/);
		assert.ok(!text.includes("x\nthen"), "command newlines must be collapsed");
	});

	it("labels a plugin approval differently from an exec one", () => {
		assert.match(buildSlackApprovalText({ command: "do thing", approvalKind: "plugin" }), /plugin action/);
	});
});

describe("parseSlackApprovalAction", () => {
	it("returns null for a non-approval (general) action", () => {
		assert.equal(parseSlackApprovalAction([{ action_id: "brigade_general", value: "g:buy" }]), null);
	});

	it("returns null when there are no actions", () => {
		assert.equal(parseSlackApprovalAction(undefined), null);
		assert.equal(parseSlackApprovalAction([]), null);
	});
});
