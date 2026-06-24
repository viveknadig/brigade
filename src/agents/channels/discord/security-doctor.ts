/**
 * Discord security-doctor helpers — the pure predicates the security audit +
 * numeric-id scan build on.
 *
 * Two concerns:
 *   1. `isDiscordMutableAllowEntry` — is an allow-from entry a MUTABLE identity
 *      (a name / tag / handle) rather than a stable id? A Discord username can be
 *      changed by its owner, so a name-based allow entry can silently grant
 *      access to a DIFFERENT person later. Id-based entries (`123`, `<@123>`,
 *      `user:123`) are stable and fine; bare names + empty-prefixed entries warn.
 *   2. `scanDiscordNumericIdHazards` — find snowflake ids that were parsed as JS
 *      NUMBERS in config (precision loss above 2^53). A Discord id stored as a
 *      number silently corrupts above that boundary; this flags them and marks
 *      which can be safely repaired to a string (lossless) vs which already lost
 *      precision (refuse — the original digits are gone).
 */

/** JS-safe integer ceiling — above this a snowflake-as-number has lost precision. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/**
 * True when `raw` is a MUTABLE allow-from identity (a name/tag/handle) rather
 * than a stable id. A bare numeric id, a `<@id>` / `<@!id>` mention, or a
 * `discord:` / `user:` / `pk:` prefix carrying a non-empty id → stable (returns
 * false). A bare name, or a prefix with an EMPTY id, → mutable (returns true).
 * `*` (wildcard) and empty are not mutable identities (returns false).
 */
export function isDiscordMutableAllowEntry(raw: string): boolean {
	const text = (raw ?? "").trim();
	if (!text || text === "*") return false;
	// `<@123>` / `<@!123>` mention → strip the wrapper; numeric inside = stable.
	const maybeMentionId = text.replace(/^<@!?/, "").replace(/>$/, "");
	if (/^\d+$/.test(maybeMentionId)) return false;
	for (const prefix of ["discord:", "user:", "pk:"]) {
		if (!text.startsWith(prefix)) continue;
		// `user:` with an empty id is a mutable/incomplete entry; `user:123` is stable.
		return text.slice(prefix.length).trim().length === 0;
	}
	// Anything else (a bare name / tag) is mutable.
	return true;
}

/** One flagged snowflake-as-number hazard. */
export interface DiscordNumericIdHazard {
	/** Config path where the lossy number lives (e.g. `channels.discord.guilds.123`). */
	path: string;
	/** The raw number as Brigade read it. */
	value: number;
	/** True when the value is ≤ 2^53-1 → can be losslessly repaired to a string. */
	repairable: boolean;
}

/** Recursively walk an object, flagging numeric values that look like snowflakes. */
function walkForNumericIds(node: unknown, path: string, out: DiscordNumericIdHazard[]): void {
	if (typeof node === "number") {
		// A Discord snowflake is a large integer. Flag big integers (≥ 1e15, near
		// the 2^53 safe-integer ceiling) — small numbers (debounceMs, position,
		// durations) aren't ids. `repairable` is true only when the value is still
		// ≤ 2^53-1 (lossless to stringify); a larger value already lost precision.
		// NOTE: real snowflakes (17-19 digits) ALWAYS exceed 2^53, so an
		// unquoted-snowflake-in-JSON is effectively never safely repairable — this
		// flags the hazard so the operator re-enters the id as a quoted string.
		if (Number.isInteger(node) && node >= 1e15) {
			out.push({ path, value: node, repairable: node <= MAX_SAFE });
		}
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((child, i) => walkForNumericIds(child, `${path}[${i}]`, out));
		return;
	}
	if (node && typeof node === "object") {
		for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
			walkForNumericIds(child, path ? `${path}.${key}` : key, out);
		}
	}
}

/**
 * Scan a `channels.discord` config slot for snowflake ids that were parsed as JS
 * numbers (JSON without quotes). Returns the flagged hazards: `repairable: true`
 * ones are ≤ 2^53-1 and can be safely converted to strings; `repairable: false`
 * ones already lost precision (refuse to "repair" — the original id is
 * unrecoverable; the operator must re-enter it as a quoted string). Pure; the
 * caller decides whether to warn-only or repair.
 */
export function scanDiscordNumericIdHazards(discordConfig: unknown, basePath = "channels.discord"): DiscordNumericIdHazard[] {
	const out: DiscordNumericIdHazard[] = [];
	if (!discordConfig || typeof discordConfig !== "object") return out;
	walkForNumericIds(discordConfig, basePath, out);
	return out;
}
