// Big-integer-preserving JSON parse for Ollama's native /api/chat responses.
//
// Ollama chat chunks carry nanosecond duration fields (`total_duration`,
// `eval_duration`, …) and occasionally large integer tool-call arguments that
// exceed Number.MAX_SAFE_INTEGER (2^53 − 1). A plain `JSON.parse` silently
// rounds those to the nearest double, corrupting the value. This parser scans
// the raw JSON text and QUOTES any unsafe integer literal (turning it into a
// string) before `JSON.parse`, so the exact digits survive. Floats/exponentials
// and integers inside string values are left untouched.

const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"

function isAsciiDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= "0" && ch <= "9";
}

/** Parse one JSON number token starting at `start`. Returns its literal text,
 *  end index, and whether it is a pure integer (no fraction/exponent). */
function parseJsonNumberToken(
	input: string,
	start: number,
): { token: string; end: number; isInteger: boolean } | null {
	let idx = start;
	if (input[idx] === "-") idx += 1;
	if (idx >= input.length) return null;

	if (input[idx] === "0") {
		idx += 1;
	} else if (isAsciiDigit(input[idx])) {
		while (isAsciiDigit(input[idx])) idx += 1;
	} else {
		return null;
	}

	let isInteger = true;
	if (input[idx] === ".") {
		isInteger = false;
		idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}

	if (input[idx] === "e" || input[idx] === "E") {
		isInteger = false;
		idx += 1;
		if (input[idx] === "+" || input[idx] === "-") idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}

	return { token: input.slice(start, idx), end: idx, isInteger };
}

/** True when `token` is an integer literal whose magnitude exceeds
 *  Number.MAX_SAFE_INTEGER (so `JSON.parse` would lose precision). */
function isUnsafeIntegerLiteral(token: string): boolean {
	const digits = token[0] === "-" ? token.slice(1) : token;
	if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) return false;
	if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) return true;
	return digits > MAX_SAFE_INTEGER_ABS_STR; // equal length → lexicographic compare
}

/** Rewrite the raw JSON text, quoting every unsafe integer literal. A tiny
 *  string-literal state machine keeps numbers inside strings untouched. */
function quoteUnsafeIntegerLiterals(input: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	let idx = 0;

	while (idx < input.length) {
		const ch = input[idx] ?? "";
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			idx += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			idx += 1;
			continue;
		}
		if (ch === "-" || isAsciiDigit(ch)) {
			const parsed = parseJsonNumberToken(input, idx);
			if (parsed) {
				out += parsed.isInteger && isUnsafeIntegerLiteral(parsed.token) ? `"${parsed.token}"` : parsed.token;
				idx = parsed.end;
				continue;
			}
		}
		out += ch;
		idx += 1;
	}
	return out;
}

/** `JSON.parse` that preserves integers beyond MAX_SAFE_INTEGER as strings. */
export function parseJsonPreservingUnsafeIntegers(input: string): unknown {
	return JSON.parse(quoteUnsafeIntegerLiterals(input)) as unknown;
}

/** Coerce a value to a plain object: parse JSON strings (big-int-safe), pass
 *  objects through, and collapse arrays / non-objects / parse failures to null. */
export function parseJsonObjectPreservingUnsafeIntegers(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			const parsed = parseJsonPreservingUnsafeIntegers(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return null;
		}
		return null;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}
