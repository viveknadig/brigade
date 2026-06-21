import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";

import { SearchableSelectList } from "./searchable-select.js";

// Identity theme — the renderers are irrelevant to filter/selection logic.
const theme: SelectListTheme = {
	selectedPrefix: (t) => t,
	selectedText: (t) => t,
	description: (t) => t,
	scrollInfo: (t) => t,
	noMatch: (t) => t,
};

const items: SelectItem[] = [
	{ value: "claude-opus-4-7", label: "claude-opus-4-7", description: "flagship reasoning" },
	{ value: "claude-haiku-4-5", label: "claude-haiku-4-5", description: "fast + cheap" },
	{ value: "gpt-5.5-mini", label: "gpt-5.5-mini", description: "small openai" },
	{ value: "gemini-3.1-pro", label: "gemini-3.1-pro", description: "google" },
];

function type(list: SearchableSelectList, text: string): void {
	for (const ch of text) list.handleInput(ch);
}

describe("SearchableSelectList — type-to-filter", () => {
	it("fuzzy-matches a mid-string term that prefix-match would miss", () => {
		const list = new SearchableSelectList(items, 12, theme);
		// "opus" is mid-string in "claude-opus-4-7" — Pi's prefix setFilter would
		// miss it; fuzzy finds it.
		type(list, "opus");
		assert.equal(list.getSelectedItem()?.value, "claude-opus-4-7");
	});

	it("matches against the description too", () => {
		const list = new SearchableSelectList(items, 12, theme);
		type(list, "flagship");
		assert.equal(list.getSelectedItem()?.value, "claude-opus-4-7");
	});

	it("narrows to a single match", () => {
		const list = new SearchableSelectList(items, 12, theme);
		type(list, "mini");
		assert.equal(list.getSelectedItem()?.value, "gpt-5.5-mini");
	});

	it("backspace restores earlier matches and clearing returns the full list top", () => {
		const list = new SearchableSelectList(items, 12, theme);
		type(list, "haiku");
		assert.equal(list.getSelectedItem()?.value, "claude-haiku-4-5");
		// Delete the query entirely → back to the full, original-order list.
		for (let i = 0; i < "haiku".length; i++) list.handleInput("\x7f");
		assert.equal(list.getSelectedItem()?.value, "claude-opus-4-7");
	});

	it("no match → null selected item", () => {
		const list = new SearchableSelectList(items, 12, theme);
		type(list, "zzzznope");
		assert.equal(list.getSelectedItem(), null);
	});

	it("renders a header line above the inner list", () => {
		const list = new SearchableSelectList(items, 12, theme, {
			formatHeader: (q) => `Q:${q}`,
		});
		type(list, "gpt");
		const lines = list.render(80);
		assert.equal(lines[0], "Q:gpt");
		assert.ok(lines.length > 1, "expected the inner list rows after the header");
	});

	it("passes a LIVE match count + total to formatHeader (not a stale string)", () => {
		const seen: Array<{ q: string; match: number; total: number }> = [];
		const list = new SearchableSelectList(items, 12, theme, {
			formatHeader: (q, match, total) => {
				seen.push({ q, match, total });
				return `${match}/${total}`;
			},
		});
		// Empty query → all 4 match.
		assert.equal(list.render(80)[0], "4/4");
		// "claude" → 2 matches (opus + haiku), total stays 4.
		type(list, "claude");
		assert.equal(list.render(80)[0], "2/4");
		// "openai" (in gpt-5.5-mini's description only) → exactly 1 match.
		// (NB: "mini" would match 2 — it's a subsequence of ge·mini· too.)
		const list2 = new SearchableSelectList(items, 12, theme, {
			formatHeader: (_q, match, total) => `${match}/${total}`,
		});
		type(list2, "openai");
		assert.equal(list2.render(80)[0], "1/4");
	});
});
