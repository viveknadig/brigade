/**
 * Tests for the shared web_search filter helpers — ISO date parsing,
 * freshness mapping, and the typed-error envelope.
 *
 * These functions are pure + cheap to test; they're load-bearing for
 * Brave + Perplexity per-call filter args, so any drift gets caught
 * here rather than at integration time.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildUnsupportedSearchFilterResponse,
	isoToPerplexityDate,
	normalizeFreshness,
	normalizeToIsoDate,
	parseIsoDateRange,
	WEB_DOCS_URL,
} from "./web-search-filters.js";

describe("normalizeToIsoDate", () => {
	it("passes through a valid ISO date", () => {
		assert.equal(normalizeToIsoDate("2026-03-15"), "2026-03-15");
	});

	it("accepts M/D/YYYY shorthand and normalises with zero-padding", () => {
		assert.equal(normalizeToIsoDate("3/5/2026"), "2026-03-05");
		assert.equal(normalizeToIsoDate("12/31/2025"), "2025-12-31");
	});

	it("rejects calendar-invalid dates (Feb 30)", () => {
		assert.equal(normalizeToIsoDate("2026-02-30"), undefined);
		assert.equal(normalizeToIsoDate("2026-13-01"), undefined);
	});

	it("rejects garbage strings", () => {
		assert.equal(normalizeToIsoDate("yesterday"), undefined);
		assert.equal(normalizeToIsoDate(""), undefined);
	});
});

describe("isoToPerplexityDate", () => {
	it("strips leading zeros for month/day", () => {
		assert.equal(isoToPerplexityDate("2026-03-05"), "3/5/2026");
		assert.equal(isoToPerplexityDate("2026-12-31"), "12/31/2026");
	});

	it("returns undefined for non-ISO input", () => {
		assert.equal(isoToPerplexityDate("garbage"), undefined);
	});
});

describe("parseIsoDateRange", () => {
	it("normalises a valid range", () => {
		const result = parseIsoDateRange({
			rawDateAfter: "2026-01-01",
			rawDateBefore: "2026-01-31",
			invalidDateAfterMessage: "after",
			invalidDateBeforeMessage: "before",
			invalidDateRangeMessage: "range",
		});
		assert.deepEqual(result, { dateAfter: "2026-01-01", dateBefore: "2026-01-31" });
	});

	it("returns invalid_date when date_after is garbage", () => {
		const result = parseIsoDateRange({
			rawDateAfter: "nonsense",
			rawDateBefore: undefined,
			invalidDateAfterMessage: "bad after",
			invalidDateBeforeMessage: "bad before",
			invalidDateRangeMessage: "bad range",
		});
		assert.deepEqual(result, {
			error: "invalid_date",
			message: "bad after",
			docs: WEB_DOCS_URL,
		});
	});

	it("returns invalid_date_range when after > before", () => {
		const result = parseIsoDateRange({
			rawDateAfter: "2026-03-15",
			rawDateBefore: "2026-01-01",
			invalidDateAfterMessage: "bad after",
			invalidDateBeforeMessage: "bad before",
			invalidDateRangeMessage: "after > before",
		});
		assert.deepEqual(result, {
			error: "invalid_date_range",
			message: "after > before",
			docs: WEB_DOCS_URL,
		});
	});

	it("honours a caller-provided docs override", () => {
		const result = parseIsoDateRange({
			rawDateAfter: "bad",
			rawDateBefore: undefined,
			invalidDateAfterMessage: "m",
			invalidDateBeforeMessage: "m",
			invalidDateRangeMessage: "m",
			docs: "https://example.com/docs",
		});
		assert.equal(
			(result as { docs?: string }).docs,
			"https://example.com/docs",
		);
	});
});

describe("normalizeFreshness", () => {
	it("brave passes through Brave shortcuts unchanged", () => {
		assert.equal(normalizeFreshness("pd", "brave"), "pd");
		assert.equal(normalizeFreshness("py", "brave"), "py");
	});

	it("brave converts Perplexity recency labels to Brave shortcuts", () => {
		assert.equal(normalizeFreshness("day", "brave"), "pd");
		assert.equal(normalizeFreshness("week", "brave"), "pw");
		assert.equal(normalizeFreshness("month", "brave"), "pm");
		assert.equal(normalizeFreshness("year", "brave"), "py");
	});

	it("perplexity converts Brave shortcuts to recency labels", () => {
		assert.equal(normalizeFreshness("pd", "perplexity"), "day");
		assert.equal(normalizeFreshness("pw", "perplexity"), "week");
	});

	it("perplexity passes through recency labels unchanged", () => {
		assert.equal(normalizeFreshness("year", "perplexity"), "year");
	});

	it("brave accepts a YYYY-MM-DDtoYYYY-MM-DD range", () => {
		assert.equal(
			normalizeFreshness("2026-01-01to2026-01-31", "brave"),
			"2026-01-01to2026-01-31",
		);
	});

	it("brave rejects an inverted range", () => {
		assert.equal(
			normalizeFreshness("2026-03-15to2026-01-01", "brave"),
			undefined,
		);
	});

	it("returns undefined for garbage", () => {
		assert.equal(normalizeFreshness("nonsense", "brave"), undefined);
		assert.equal(normalizeFreshness("", "perplexity"), undefined);
		assert.equal(normalizeFreshness(undefined, "brave"), undefined);
	});
});

describe("buildUnsupportedSearchFilterResponse", () => {
	it("returns undefined when no filters are present", () => {
		assert.equal(buildUnsupportedSearchFilterResponse({}, "duckduckgo"), undefined);
		assert.equal(
			buildUnsupportedSearchFilterResponse({ query: "x" }, "duckduckgo"),
			undefined,
		);
	});

	it("flags country with a typed error", () => {
		const result = buildUnsupportedSearchFilterResponse(
			{ country: "DE" },
			"duckduckgo",
		);
		assert.ok(result);
		assert.equal(result?.error, "unsupported_country");
		assert.match(result!.message, /country filtering/);
		assert.match(result!.message, /duckduckgo/);
		assert.match(result!.message, /Brave and Perplexity/);
	});

	it("collapses date_after + date_before into a single unsupported_date_filter", () => {
		const result = buildUnsupportedSearchFilterResponse(
			{ date_after: "2026-01-01" },
			"duckduckgo",
		);
		assert.equal(result?.error, "unsupported_date_filter");
		assert.match(result!.message, /date_after\/date_before filtering/);
	});

	it("flags language + freshness", () => {
		assert.equal(
			buildUnsupportedSearchFilterResponse({ language: "en" }, "exa")?.error,
			"unsupported_language",
		);
		assert.equal(
			buildUnsupportedSearchFilterResponse({ freshness: "pd" }, "exa")?.error,
			"unsupported_freshness",
		);
	});

	it("ignores empty/whitespace filter values", () => {
		assert.equal(
			buildUnsupportedSearchFilterResponse({ country: "   " }, "exa"),
			undefined,
		);
	});

	it("uses the Brigade docs URL by default", () => {
		const result = buildUnsupportedSearchFilterResponse(
			{ country: "DE" },
			"duckduckgo",
		);
		assert.equal(result?.docs, WEB_DOCS_URL);
	});

	it("honours a caller-provided docs override", () => {
		const result = buildUnsupportedSearchFilterResponse(
			{ country: "DE" },
			"duckduckgo",
			"https://example.com/docs",
		);
		assert.equal(result?.docs, "https://example.com/docs");
	});
});
