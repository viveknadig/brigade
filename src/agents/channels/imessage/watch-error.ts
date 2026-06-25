/**
 * iMessage watch-error payload sanitization.
 *
 * The `imsg rpc` stream can emit an `error` notification whose `params` is an
 * arbitrary, attacker-influenced object (a remote bridge, a malformed row). The
 * connection logs it — so before logging we reduce it to a finite, bounded shape:
 * a numeric `code` (only when finite) + a sanitized, length-capped `message`
 * (terminal control chars stripped so a crafted payload can't smuggle ANSI /
 * cursor escapes into the operator's terminal or log file).
 *
 * Ported from the upstream `sanitizeIMessageWatchErrorPayload`.
 */

/** Max retained chars of a watch-error message before truncation. */
const MAX_WATCH_ERROR_MESSAGE_CHARS = 200;

/** The safe, bounded watch-error shape that is logged. */
export interface SanitizedIMessageWatchErrorPayload {
	code?: number;
	message?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Strip terminal/control characters from untrusted text for single-line log
 * rendering: CR/LF/TAB become visible escapes, then every remaining C0/C1
 * control char (incl. ANSI ESC 0x1b) is removed.
 */
function sanitizeTerminalText(input: string): string {
	const normalized = input.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
	let sanitized = "";
	for (const char of normalized) {
		const code = char.charCodeAt(0);
		const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
		if (!isControl) sanitized += char;
	}
	return sanitized;
}

/** Truncate to `max` UTF-16 code units without splitting a surrogate pair. */
function truncateUtf16Safe(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	let end = max;
	// Don't cut between a high + low surrogate.
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

/**
 * Reduce a raw watch `error` notification's `params` to a finite `code` +
 * sanitized/truncated `message`. Anything that isn't a plain object → `{}`.
 */
export function sanitizeIMessageWatchErrorPayload(payload: unknown): SanitizedIMessageWatchErrorPayload {
	if (!isRecord(payload)) return {};
	const safe: SanitizedIMessageWatchErrorPayload = {};
	if (typeof payload.code === "number" && Number.isFinite(payload.code)) {
		safe.code = payload.code;
	}
	if (typeof payload.message === "string") {
		const sanitized = sanitizeTerminalText(payload.message);
		if (sanitized) {
			safe.message =
				sanitized.length > MAX_WATCH_ERROR_MESSAGE_CHARS
					? `${truncateUtf16Safe(sanitized, MAX_WATCH_ERROR_MESSAGE_CHARS - 1)}…`
					: sanitized;
		}
	}
	return safe;
}
