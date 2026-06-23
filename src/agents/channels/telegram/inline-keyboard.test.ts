import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	decodeGeneralCallbackData,
	GENERAL_CALLBACK_PREFIX,
	isGeneralCallbackData,
} from "../general-callback.js";
import { buildTelegramInlineKeyboard } from "./inline-keyboard.js";

describe("general callback convention", () => {
	it("round-trips a token through prefix + decode", () => {
		const data = `${GENERAL_CALLBACK_PREFIX}buy`;
		assert.equal(isGeneralCallbackData(data), true);
		assert.equal(decodeGeneralCallbackData(data), "buy");
	});

	it("treats a non-prefixed (approval) payload as NOT general", () => {
		assert.equal(isGeneralCallbackData("A1.allow.xyz"), false);
		assert.equal(decodeGeneralCallbackData("A1.allow.xyz"), "");
	});
});

describe("buildTelegramInlineKeyboard", () => {
	it("prefixes button data and preserves the row layout", () => {
		const kb = buildTelegramInlineKeyboard([
			[
				{ text: "Yes", data: "yes" },
				{ text: "No", data: "no" },
			],
		]);
		assert.ok(kb);
		assert.equal(kb?.inline_keyboard.length, 1);
		assert.equal(kb?.inline_keyboard[0]?.[0]?.text, "Yes");
		assert.equal(kb?.inline_keyboard[0]?.[0]?.callback_data, `${GENERAL_CALLBACK_PREFIX}yes`);
		assert.equal(kb?.inline_keyboard[0]?.[1]?.callback_data, `${GENERAL_CALLBACK_PREFIX}no`);
	});

	it("drops a button with an empty label or data", () => {
		const kb = buildTelegramInlineKeyboard([
			[
				{ text: "", data: "x" },
				{ text: "Keep", data: "k" },
				{ text: "NoData", data: "" },
			],
		]);
		assert.equal(kb?.inline_keyboard[0]?.length, 1);
		assert.equal(kb?.inline_keyboard[0]?.[0]?.text, "Keep");
	});

	it("rejects (drops) a token that overflows the 64-byte callback budget", () => {
		const huge = "z".repeat(70);
		const kb = buildTelegramInlineKeyboard([[{ text: "Big", data: huge }]]);
		assert.equal(kb, null, "no usable button → null keyboard");
	});

	it("returns null for an all-empty grid", () => {
		assert.equal(buildTelegramInlineKeyboard([[]]), null);
		assert.equal(buildTelegramInlineKeyboard([]), null);
	});

	it("reflows a long single-column list into capped rows", () => {
		const kb = buildTelegramInlineKeyboard([
			[{ text: "1", data: "1" }],
			[{ text: "2", data: "2" }],
			[{ text: "3", data: "3" }],
			[{ text: "4", data: "4" }],
		]);
		assert.ok(kb);
		// 4 single-button rows reflow into rows of at most 3.
		assert.equal(kb?.inline_keyboard.length, 2);
		assert.equal(kb?.inline_keyboard[0]?.length, 3);
		assert.equal(kb?.inline_keyboard[1]?.length, 1);
	});
});
