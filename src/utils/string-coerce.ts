/**
 * String-coercion helpers shared across routing, session-key building, tool
 * input parsing, and config normalisation. Brand-scrubbed lift of the
 * upstream reference codebase's shared/string-coerce module — the call
 * sites in the lifted route resolver, account-id canonicaliser, message-
 * channel helpers, and session-key parser all rely on these exact
 * signatures.
 *
 * All functions accept `unknown` (no try/catch boilerplate at call sites)
 * and return predictable shapes — never throw.
 *
 *   - `readStringValue(value)`            string | undefined narrower
 *   - `normalizeNullableString(value)`    trim → string OR null (drops empties)
 *   - `normalizeOptionalString(value)`    trim → string OR undefined
 *   - `normalizeStringifiedOptionalString(value)` accepts string/number/boolean/bigint
 *   - `normalizeOptionalLowercaseString(value)`   trim → lowercase OR undefined
 *   - `normalizeLowercaseStringOrEmpty(value)`    trim → lowercase string ("" on invalid)
 *   - `lowercasePreservingWhitespace(s)`  toLowerCase, no trim
 *   - `localeLowercasePreservingWhitespace(s)` toLocaleLowerCase, no trim
 *   - `resolvePrimaryStringValue(value)`  unwrap `{primary: "..."}` or pass-through string
 *   - `normalizeOptionalThreadValue(value)`  string | finite-int OR undefined (thread ids)
 *   - `normalizeOptionalStringifiedId(value)` thread-id → canonical string
 *   - `hasNonEmptyString(value)`          typeguard for non-empty string
 *   - `truncateUtf16Safe(str, maxLen)`    truncate without splitting a surrogate
 *
 * The reference codebase has this module under `src/shared/`. Brigade lives
 * under `src/utils/`; `shared/string-coerce.ts` re-exports from here so lifts
 * that import the original path keep compiling.
 */

export function readStringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function normalizeNullableString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function normalizeOptionalString(value: unknown): string | undefined {
	return normalizeNullableString(value) ?? undefined;
}

export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
	if (typeof value === "string") return normalizeOptionalString(value);
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return normalizeOptionalString(String(value));
	}
	return undefined;
}

export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
	return normalizeOptionalString(value)?.toLowerCase();
}

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
	return normalizeOptionalLowercaseString(value) ?? "";
}

export function lowercasePreservingWhitespace(value: string): string {
	return value.toLowerCase();
}

export function localeLowercasePreservingWhitespace(value: string): string {
	return value.toLocaleLowerCase();
}

export function resolvePrimaryStringValue(value: unknown): string | undefined {
	if (typeof value === "string") return normalizeOptionalString(value);
	if (!value || typeof value !== "object") return undefined;
	return normalizeOptionalString((value as { primary?: unknown }).primary);
}

export function normalizeOptionalThreadValue(value: unknown): string | number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.trunc(value) : undefined;
	}
	return normalizeOptionalString(value);
}

export function normalizeOptionalStringifiedId(value: unknown): string | undefined {
	const normalized = normalizeOptionalThreadValue(value);
	return normalized == null ? undefined : String(normalized);
}

export function hasNonEmptyString(value: unknown): value is string {
	return normalizeOptionalString(value) !== undefined;
}

/**
 * Truncate at `maxLen` characters without splitting a UTF-16 surrogate pair.
 * A trailing `…` (one char) is appended ONLY when truncation occurred; the
 * resulting length is at most `maxLen + 1`. Brigade-only addition — used by
 * `sessions_history` to enforce the 80 KiB byte cap on transcript chunks
 * without producing an invalid string mid-emoji.
 */
export function truncateUtf16Safe(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	let end = maxLen;
	const codeUnit = str.charCodeAt(end - 1);
	const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff;
	if (isHighSurrogate) end -= 1;
	return `${str.slice(0, end)}…`;
}
