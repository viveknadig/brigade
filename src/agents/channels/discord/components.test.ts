import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeGeneralCallbackData, GENERAL_CALLBACK_PREFIX, isGeneralCallbackData } from "../general-callback.js";
import {
	buildDiscordApprovalRows,
	buildDiscordButtonRows,
	DISCORD_BUTTON_STYLE,
	DISCORD_CUSTOM_ID_MAX_CHARS,
	sanitizeDiscordCustomId,
} from "./components.js";

describe("general callback convention (discord)", () => {
	it("round-trips a token through prefix + decode", () => {
		const data = `${GENERAL_CALLBACK_PREFIX}buy`;
		assert.equal(isGeneralCallbackData(data), true);
		assert.equal(decodeGeneralCallbackData(data), "buy");
	});
});

describe("buildDiscordButtonRows", () => {
	it("prefixes button values into the custom_id", () => {
		const rows = buildDiscordButtonRows([
			[
				{ text: "Yes", data: "yes" },
				{ text: "No", data: "no" },
			],
		]);
		assert.ok(rows);
		assert.equal(rows?.length, 1);
		assert.equal(rows?.[0]?.[0]?.label, "Yes");
		assert.equal(rows?.[0]?.[0]?.customId, `${GENERAL_CALLBACK_PREFIX}yes`);
		assert.equal(rows?.[0]?.[1]?.customId, `${GENERAL_CALLBACK_PREFIX}no`);
		assert.equal(rows?.[0]?.[0]?.style, DISCORD_BUTTON_STYLE.Secondary);
	});

	it("drops a button with an empty label or data", () => {
		const rows = buildDiscordButtonRows([
			[
				{ text: "", data: "x" },
				{ text: "Keep", data: "k" },
				{ text: "NoData", data: "" },
			],
		]);
		assert.equal(rows?.[0]?.length, 1);
		assert.equal(rows?.[0]?.[0]?.label, "Keep");
	});

	it("rejects (drops) a custom_id that overflows the 100-char budget", () => {
		const huge = "z".repeat(120);
		assert.equal(buildDiscordButtonRows([[{ text: "Big", data: huge }]]), null);
	});

	it("returns null for an all-empty grid", () => {
		assert.equal(buildDiscordButtonRows([[]]), null);
		assert.equal(buildDiscordButtonRows([]), null);
	});

	it("chunks more than 5 buttons into separate rows (5 per row)", () => {
		const grid = [Array.from({ length: 7 }, (_v, i) => ({ text: `b${i}`, data: `${i}` }))];
		const rows = buildDiscordButtonRows(grid);
		assert.ok(rows);
		assert.equal(rows?.length, 2);
		assert.equal(rows?.[0]?.length, 5);
		assert.equal(rows?.[1]?.length, 2);
	});

	it("caps at 5 rows (Discord's per-message row limit)", () => {
		const grid = [Array.from({ length: 40 }, (_v, i) => ({ text: `b${i}`, data: `${i}` }))];
		const rows = buildDiscordButtonRows(grid);
		assert.equal(rows?.length, 5);
	});
});

describe("buildDiscordApprovalRows", () => {
	it("shapes codec specs into approval buttons with styles", () => {
		const rows = buildDiscordApprovalRows([
			{ label: "Allow once", data: "bv1:abc:o", decision: "allow-once" },
			{ label: "Allow always", data: "bv1:abc:a", decision: "allow-always" },
			{ label: "Deny", data: "bv1:abc:d", decision: "deny" },
		]);
		assert.equal(rows.length, 1);
		const btns = rows[0] ?? [];
		assert.equal(btns.length, 3);
		assert.equal(btns[0]?.customId, "bv1:abc:o");
		assert.equal(btns[0]?.style, DISCORD_BUTTON_STYLE.Success);
		assert.equal(btns[2]?.style, DISCORD_BUTTON_STYLE.Danger);
	});

	it("returns [] when fewer than two buttons are usable", () => {
		assert.deepEqual(buildDiscordApprovalRows([{ label: "Only", data: "bv1:x:o" }]), []);
	});
});

describe("sanitizeDiscordCustomId", () => {
	it("drops control bytes but keeps the codec payload", () => {
		assert.equal(sanitizeDiscordCustomId("bv1:abc:o"), "bv1:abc:o");
		assert.equal(sanitizeDiscordCustomId(`bv1${String.fromCharCode(0)}:o`), "bv1:o");
	});

	it("exposes the 100-char limit", () => {
		assert.equal(DISCORD_CUSTOM_ID_MAX_CHARS, 100);
	});
});
