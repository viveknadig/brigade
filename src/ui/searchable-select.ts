/**
 * `SearchableSelectList` — a Pi-TUI `SelectList` with a live type-to-filter
 * search box on top. Drop-in for `SelectList`: same `SelectItem[]` +
 * `onSelect`/`onCancel` contract, so callers swap one for the other and call
 * `tui.setFocus(list)` as usual.
 *
 * Why not Pi's built-in `SelectList.setFilter`? It prefix-matches on the
 * item's `value` only (`value.startsWith(query)`), so typing "opus" would NOT
 * match "claude-opus-4-7", and it doesn't filter as you type. This wraps
 * `SelectList` and drives Pi's own `fuzzyFilter` (all query tokens must appear
 * in order across label+value+description) — so "opus" finds the Claude Opus
 * row and "gpt mini" finds gpt-*-mini. Essential once a provider (OpenRouter)
 * exposes 270+ models.
 *
 * Keys: ↑/↓ + Enter delegate to the inner SelectList; Esc/Ctrl+C cancels;
 * Backspace edits the query; any printable character appends to the query and
 * re-filters. The TUI re-renders after each `handleInput`, so mutating state
 * here is enough (no explicit requestRender needed — same as SelectList).
 */

import {
	decodeKittyPrintable,
	fuzzyFilter,
	getKeybindings,
	Key,
	matchesKey,
	type Component,
	SelectList,
	type SelectItem,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "@earendil-works/pi-tui";

export interface SearchableSelectOptions extends SelectListLayoutOptions {
	/**
	 * Format the search header line. Receives the live query AND the current
	 * match count / total so the header can show "(4/272)" that updates as you
	 * type. Style it here (e.g. dim).
	 */
	formatHeader?: (query: string, matchCount: number, total: number) => string;
}

export class SearchableSelectList implements Component {
	private query = "";
	private inner: SelectList;
	/** Number of items currently matching the query (live; = total when empty). */
	private matchCount: number;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;

	constructor(
		private readonly allItems: SelectItem[],
		private readonly maxVisible: number,
		private readonly theme: SelectListTheme,
		private readonly options: SearchableSelectOptions = {},
	) {
		this.inner = this.buildInner(allItems);
		this.matchCount = allItems.length;
	}

	private buildInner(items: SelectItem[]): SelectList {
		const visible = Math.min(Math.max(items.length, 1), this.maxVisible);
		const list = new SelectList(items, visible, this.theme, this.options);
		// Forward selection/cancel through this wrapper so callers wire onSelect
		// on the SearchableSelectList, not the (recreated) inner list.
		list.onSelect = (item) => this.onSelect?.(item);
		list.onCancel = () => this.onCancel?.();
		return list;
	}

	private applyFilter(): void {
		const q = this.query.trim();
		const filtered = q
			? fuzzyFilter(this.allItems, q, (it) => `${it.label} ${it.value} ${it.description ?? ""}`)
			: this.allItems;
		this.matchCount = filtered.length;
		// Rebuild the inner list so navigation + scroll operate on the filtered
		// set and the selection resets to the top match.
		this.inner = this.buildInner(filtered);
	}

	render(width: number): string[] {
		const total = this.allItems.length;
		const header = this.options.formatHeader
			? this.options.formatHeader(this.query, this.matchCount, total)
			: this.query
				? `  search: ${this.query}  (${this.matchCount}/${total})`
				: `  ${total} items · type to filter · ↑↓ move · Enter select · Esc back`;
		return [header, ...this.inner.render(width)];
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Navigation + confirm → the inner list owns these.
		if (
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm")
		) {
			this.inner.handleInput(keyData);
			return;
		}
		// Esc / Ctrl+C → cancel.
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		// Backspace → trim the query (matchesKey covers raw + kitty encodings).
		if (matchesKey(keyData, Key.backspace) || keyData === "\x7f" || keyData === "\b") {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.applyFilter();
			}
			return;
		}
		// Printable character → append to the query + re-filter. Handle the
		// kitty-keyboard encoding first, then fall back to a plain ASCII byte.
		const ch =
			decodeKittyPrintable(keyData) ??
			(keyData.length === 1 && keyData.charCodeAt(0) >= 0x20 && keyData.charCodeAt(0) !== 0x7f
				? keyData
				: undefined);
		if (ch && ch.length === 1) {
			this.query += ch;
			this.applyFilter();
		}
	}

	invalidate(): void {
		(this.inner as unknown as { invalidate?: () => void }).invalidate?.();
	}

	getSelectedItem(): SelectItem | null {
		return this.inner.getSelectedItem();
	}
}
