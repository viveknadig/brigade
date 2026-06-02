/**
 * Object-key safety guard.
 *
 * `isBlockedObjectKey(key)` returns true for the three JavaScript object
 * keys that, when used as a property name on a plain object literal or as
 * a `Map.set(key, ...)` argument, can poison the prototype chain or
 * corrupt the prototype-walk of any later reader: `__proto__`,
 * `prototype`, `constructor`.
 *
 * Every Brigade subsystem that turns USER-CONTROLLED or MODEL-CONTROLLED
 * input into a property name / map key MUST run it through this guard
 * first. Today the consumers are: account-id canonicalisation, session-
 * key normalisation, identity-link resolution, agent-id sanitisation,
 * cron job-id sanitisation, sessions_send target-key resolution.
 *
 * Brand-scrubbed verbatim lift from the upstream reference codebase.
 */

const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isBlockedObjectKey(key: string): boolean {
	return BLOCKED_OBJECT_KEYS.has(key);
}
