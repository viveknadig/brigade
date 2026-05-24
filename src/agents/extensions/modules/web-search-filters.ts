/**
 * Shared web_search filter helpers — ISO date parsing, freshness mapping,
 * and the typed-error response shape used when an agent passes filters
 * to a provider that can't honor them.
 *
 * Why a shared module: country / language / freshness / date_after /
 * date_before flow through every provider's `execute(args)` even though
 * only Brave + Perplexity actually consume them. The non-supporting
 * providers need a uniform way to say "I can't do that" so the agent
 * gets a predictable error envelope instead of silent drop.
 *
 * The error shape — `{ error, message, docs }` — matches the contract
 * tests expect; callers should treat any return value with an `error`
 * field as terminal and not normalize it as a search hit.
 */

const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);

export const FRESHNESS_TO_RECENCY: Record<string, string> = {
	pd: "day",
	pw: "week",
	pm: "month",
	py: "year",
};

export const RECENCY_TO_FRESHNESS: Record<string, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

const BRIGADE_WEB_DOCS_URL =
	"https://github.com/Bhasvanth-Dev9380/brigade/blob/main/docs/web-tools.md";

function isValidIsoDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parts = value.split("-").map((p) => Number.parseInt(p, 10));
	const year = parts[0];
	const month = parts[1];
	const day = parts[2];
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		!Number.isFinite(year) ||
		!Number.isFinite(month) ||
		!Number.isFinite(day)
	) {
		return false;
	}
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

export function isoToPerplexityDate(iso: string): string | undefined {
	const match = iso.match(ISO_DATE_PATTERN);
	if (!match) return undefined;
	const year = match[1] ?? "";
	const month = match[2] ?? "";
	const day = match[3] ?? "";
	return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
}

/** Accept YYYY-MM-DD or M/D/YYYY; emit canonical YYYY-MM-DD; undefined on bad input. */
export function normalizeToIsoDate(value: string): string | undefined {
	const trimmed = value.trim();
	if (ISO_DATE_PATTERN.test(trimmed)) {
		return isValidIsoDate(trimmed) ? trimmed : undefined;
	}
	const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
	if (match) {
		const month = match[1] ?? "";
		const day = match[2] ?? "";
		const year = match[3] ?? "";
		const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
		return isValidIsoDate(iso) ? iso : undefined;
	}
	return undefined;
}

export interface IsoDateRangeError {
	error: "invalid_date" | "invalid_date_range";
	message: string;
	docs: string;
}

/**
 * Parse `date_after` + `date_before` together. Returns either the normalized
 * pair or a typed error. The caller picks the messages so the surfaced text
 * matches the calling provider's vocabulary.
 */
export function parseIsoDateRange(params: {
	rawDateAfter?: string;
	rawDateBefore?: string;
	invalidDateAfterMessage: string;
	invalidDateBeforeMessage: string;
	invalidDateRangeMessage: string;
	docs?: string;
}): { dateAfter?: string; dateBefore?: string } | IsoDateRangeError {
	const docs = params.docs ?? BRIGADE_WEB_DOCS_URL;
	const dateAfter = params.rawDateAfter ? normalizeToIsoDate(params.rawDateAfter) : undefined;
	if (params.rawDateAfter && !dateAfter) {
		return { error: "invalid_date", message: params.invalidDateAfterMessage, docs };
	}
	const dateBefore = params.rawDateBefore ? normalizeToIsoDate(params.rawDateBefore) : undefined;
	if (params.rawDateBefore && !dateBefore) {
		return { error: "invalid_date", message: params.invalidDateBeforeMessage, docs };
	}
	if (dateAfter && dateBefore && dateAfter > dateBefore) {
		return { error: "invalid_date_range", message: params.invalidDateRangeMessage, docs };
	}
	return { dateAfter, dateBefore };
}

/**
 * Resolve freshness across provider vocabularies. Brave uses `pd/pw/pm/py`
 * shortcuts + `YYYY-MM-DDto YYYY-MM-DD` ranges; Perplexity uses
 * `day/week/month/year` recency labels. Returns canonical form for the
 * caller's provider, or undefined if the input doesn't map.
 */
export function normalizeFreshness(
	value: string | undefined,
	provider: "brave" | "perplexity",
): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
		return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
	}
	if (PERPLEXITY_RECENCY_VALUES.has(lower)) {
		return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
	}
	if (provider === "brave") {
		const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
		if (match) {
			const start = match[1] ?? "";
			const end = match[2] ?? "";
			if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) {
				return `${start}to${end}`;
			}
		}
	}
	return undefined;
}

export type UnsupportedSearchFilterName =
	| "country"
	| "language"
	| "freshness"
	| "date_after"
	| "date_before";

export interface UnsupportedSearchFilterResponse {
	error: string;
	message: string;
	docs: string;
}

function readUnsupportedSearchFilter(
	params: Record<string, unknown>,
): UnsupportedSearchFilterName | undefined {
	for (const name of [
		"country",
		"language",
		"freshness",
		"date_after",
		"date_before",
	] as const) {
		const value = params[name];
		if (typeof value === "string" && value.trim()) return name;
	}
	return undefined;
}

function describeUnsupportedSearchFilter(name: UnsupportedSearchFilterName): string {
	switch (name) {
		case "country":
			return "country filtering";
		case "language":
			return "language filtering";
		case "freshness":
			return "freshness filtering";
		case "date_after":
		case "date_before":
			return "date_after/date_before filtering";
	}
}

/**
 * When the agent passes country/language/freshness/date_* to a provider
 * that doesn't honor any of them, return a typed error so the model
 * learns which provider to pick instead of silently degrading results.
 */
export function buildUnsupportedSearchFilterResponse(
	params: Record<string, unknown>,
	provider: string,
	docs: string = BRIGADE_WEB_DOCS_URL,
): UnsupportedSearchFilterResponse | undefined {
	const unsupported = readUnsupportedSearchFilter(params);
	if (!unsupported) return undefined;
	const label = describeUnsupportedSearchFilter(unsupported);
	const supportedLabel =
		unsupported === "date_after" || unsupported === "date_before"
			? "date filtering"
			: label;
	return {
		error: unsupported.startsWith("date_")
			? "unsupported_date_filter"
			: `unsupported_${unsupported}`,
		message: `${label} is not supported by the ${provider} provider. Only Brave and Perplexity support ${supportedLabel}.`,
		docs,
	};
}

export const WEB_DOCS_URL = BRIGADE_WEB_DOCS_URL;
