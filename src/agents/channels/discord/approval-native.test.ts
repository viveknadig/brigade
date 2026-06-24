import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildDiscordApprovalMessage, buildDiscordApprovalText, parseDiscordApprovalAction } from "./approval-native.js";

describe("buildDiscordApprovalMessage", () => {
	it("builds prompt text + button rows whose custom_ids decode back to the id", () => {
		const msg = buildDiscordApprovalMessage({
			approvalId: "exec-abc-123",
			command: "ls -la",
			approvalKind: "exec",
		});
		assert.ok(msg, "message must be built for a normal approval id");
		assert.equal(msg!.rows.length, 1);
		const btns = msg!.rows[0] ?? [];
		assert.equal(btns.length, 3);
		assert.deepEqual(btns.map((b) => b.label), ["Allow once", "Allow always", "Deny"]);
		// Each button round-trips through the parse helper to the SAME id.
		const parsed = parseDiscordApprovalAction(btns[0]!.customId);
		assert.equal(parsed?.approvalId, "exec-abc-123");
		assert.equal(parsed?.decision, "allow-once");
	});

	it("drops the Allow always button when allowAlways=false", () => {
		const msg = buildDiscordApprovalMessage({
			approvalId: "x",
			command: "do thing",
			approvalKind: "exec",
			allowAlways: false,
		});
		assert.ok(msg);
		assert.deepEqual((msg!.rows[0] ?? []).map((b) => b.label), ["Allow once", "Deny"]);
	});

	it("returns null when the approval id is too long for byte-safe buttons", () => {
		const msg = buildDiscordApprovalMessage({
			approvalId: "z".repeat(200),
			command: "x",
			approvalKind: "exec",
		});
		assert.equal(msg, null, "caller falls back to the text prompt");
	});
});

describe("buildDiscordApprovalText", () => {
	it("includes the command preview + a brand mark, control-char scrubbed", () => {
		const text = buildDiscordApprovalText({ command: "rm -rf /tmp/x\nthen more", approvalKind: "exec" });
		assert.match(text, /Brigade/);
		assert.match(text, /rm -rf/);
		assert.ok(!text.includes("x\nthen"), "command newlines must be collapsed");
	});

	it("labels a plugin approval differently from an exec one", () => {
		assert.match(buildDiscordApprovalText({ command: "do thing", approvalKind: "plugin" }), /plugin action/);
	});
});

describe("parseDiscordApprovalAction", () => {
	it("returns null for a general (non-approval) custom_id", () => {
		assert.equal(parseDiscordApprovalAction("g:buy"), null);
	});

	it("returns null for an empty / missing custom_id", () => {
		assert.equal(parseDiscordApprovalAction(undefined), null);
		assert.equal(parseDiscordApprovalAction(""), null);
	});
});
