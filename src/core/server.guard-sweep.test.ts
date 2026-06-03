/**
 * Guard sweep CI invariant (Wave O0.6 META-TEST).
 *
 * Parses `server.ts` (regex-based, no ts-morph dependency) to enumerate
 * every `registerGatewayHandler("...", ...)` registration AND every
 * `case "...":` arm of the in-process `handleRequest` dispatcher. For
 * each entry that takes a `sessionKey` / `agentId` / `targetSessionKey`
 * parameter and is not in the explicit allowlist of guard-free methods
 * (boot/status/heartbeat methods that touch no per-agent state), the
 * test asserts the handler/case body invokes `sessionsAccessCheck` OR
 * `checkSessionToolAccess` somewhere before returning.
 *
 * Purpose: catch the X-1 pattern (every Wave-O sweep so far has found
 * MORE unguarded paths after the just-shipped sweep) at PR time instead
 * of at adversarial-verify time.
 *
 * Tempdir-isolated by construction — the test reads the source file
 * directly, never spawns the gateway.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const SERVER_PATH = resolve(import.meta.dirname, "server.ts");

/**
 * Methods that do NOT need an access check because:
 *   - they take no per-session parameter (health/list-models/get-state),
 *   - they are read-only across the whole gateway (snapshot / model list),
 *   - or they are admin-scoped at the WS layer and operate on the gateway
 *     process itself (shutdown / wake / approval-resolve / subscribe).
 *
 * Any method that mutates a session, sends a message, or discloses an
 * agent's inventory MUST require a guard — and the allowlist explicitly
 * does NOT include those.
 */
const ALLOWLIST_NO_GUARD_NEEDED = new Set<string>([
	// Connection / scope-management — no per-session targeting.
	"subscribe",
	"unsubscribe",
	"approval-resolve",
	// Read-only registry / snapshot methods.
	"list-models",
	"refresh-models",
	"get-state",
	"agents.list",
	// Boot/lifecycle methods.
	"shutdown",
	"health",
	// Cron read methods + service-level snapshot (no fire-time mutation).
	"cron.status",
	"cron.list",
	"cron.remove",
	"cron.runs",
	"wake",
	// Skills install/update — admin-scoped and currently unguarded by
	// design (operator-initiated workspace mutation, not cross-agent).
	"skills.install",
	"skills.update",
	// Memory sweep — gateway-internal, no agent targeting.
	"memory.sweep",
	"memory.consolidate",
]);

/** Sessions registry methods that ARE guarded (registered with accessCheck). */
const KNOWN_GUARDED_SESSIONS_METHODS = new Set<string>([
	"sessions.list",
	"sessions.history",
	"sessions.send",
	"sessions.spawn",
	"sessions.patch",
	"agent",
	"cron.add",
	"cron.update",
	"cron.run",
	"skills.status",
]);

interface DispatcherCase {
	method: string;
	body: string;
}

function parseSwitchCases(src: string): DispatcherCase[] {
	const cases: DispatcherCase[] = [];
	// Match `case "name": { ... }` within the handleRequest switch.
	const switchRe = /\bcase\s+"([\w.\-]+)"\s*:\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = switchRe.exec(src)) !== null) {
		const method = match[1] ?? "";
		// Walk forward to find the matching closing brace.
		const start = match.index + match[0].length;
		let depth = 1;
		let i = start;
		while (i < src.length && depth > 0) {
			const ch = src[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			i++;
		}
		const body = src.slice(start, i);
		cases.push({ method, body });
	}
	return cases;
}

interface RegisteredHandler {
	method: string;
	body: string;
}

function parseRegisteredHandlers(src: string): RegisteredHandler[] {
	const handlers: RegisteredHandler[] = [];
	// Match `registerGatewayHandler("name", async? (params: unknown) => ...)`
	// across multiline. We need to find the entire callback body — easiest is
	// to find the registration call site and capture from `(params...` to the
	// matching close-paren that ends the registerGatewayHandler call.
	const startRe = /registerGatewayHandler\(\s*"([\w.\-]+)"\s*,/g;
	let match: RegExpExecArray | null;
	while ((match = startRe.exec(src)) !== null) {
		const method = match[1] ?? "";
		// Find the matching `)` for the registerGatewayHandler call.
		let depthParen = 1;
		let depthBrace = 0;
		let i = match.index + match[0].length;
		const bodyStart = i;
		while (i < src.length && depthParen > 0) {
			const ch = src[i];
			if (ch === "{") depthBrace++;
			else if (ch === "}") depthBrace--;
			else if (ch === "(" && depthBrace === 0) depthParen++;
			else if (ch === ")" && depthBrace === 0) depthParen--;
			i++;
		}
		const body = src.slice(bodyStart, i - 1);
		handlers.push({ method, body });
	}
	return handlers;
}

function bodyMentionsGuard(body: string): boolean {
	return (
		body.includes("sessionsAccessCheck") ||
		body.includes("checkSessionToolAccess") ||
		body.includes("accessCheck: sessionsAccessCheck")
	);
}

function bodyMentionsSessionParam(body: string): boolean {
	return (
		body.includes("sessionKey") ||
		body.includes("agentId") ||
		body.includes("targetSessionKey")
	);
}

describe("guard sweep — server.ts gateway handlers", () => {
	const src = readFileSync(SERVER_PATH, "utf8");

	it("every switch-case that touches a session param either guards or is allowlisted", () => {
		const cases = parseSwitchCases(src);
		// Restrict to the dispatcher switch — server.ts may contain other
		// switch statements (e.g. inside helpers). The handleRequest switch
		// has `prompt`, `abort`, `steer` at minimum; we use those as a
		// sanity anchor that we parsed at least the dispatcher.
		const methodNames = new Set(cases.map((c) => c.method));
		assert.ok(
			methodNames.has("prompt") && methodNames.has("abort"),
			`expected dispatcher anchor methods (prompt, abort) in parsed switch cases; got ${[
				...methodNames,
			]
				.sort()
				.join(", ")}`,
		);
		const offenders: string[] = [];
		for (const c of cases) {
			if (ALLOWLIST_NO_GUARD_NEEDED.has(c.method)) continue;
			if (!bodyMentionsSessionParam(c.body)) continue;
			if (!bodyMentionsGuard(c.body)) {
				offenders.push(
					`case "${c.method}": touches sessionKey/agentId but does not call sessionsAccessCheck / checkSessionToolAccess`,
				);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`Unguarded switch cases detected (Wave O0.6 invariant):\n  ${offenders.join(
				"\n  ",
			)}\n\nAdd sessionsAccessCheck(...) at the top of the case body, or, if the\nmethod legitimately takes no per-session target, add it to\nALLOWLIST_NO_GUARD_NEEDED with a justifying comment in this test.`,
		);
	});

	it("every registerGatewayHandler call either guards or is allowlisted", () => {
		const handlers = parseRegisteredHandlers(src);
		// Sanity: we must have parsed at least the well-known guarded handlers.
		const handlerNames = new Set(handlers.map((h) => h.method));
		for (const expected of [
			"sessions.list",
			"sessions.history",
			"sessions.send",
			"sessions.spawn",
			"agent",
		]) {
			assert.ok(
				handlerNames.has(expected),
				`expected registerGatewayHandler("${expected}") in parsed registrations; got ${[
					...handlerNames,
				]
					.sort()
					.join(", ")}`,
			);
		}
		const offenders: string[] = [];
		for (const h of handlers) {
			if (ALLOWLIST_NO_GUARD_NEEDED.has(h.method)) continue;
			if (!bodyMentionsSessionParam(h.body)) continue;
			if (!bodyMentionsGuard(h.body)) {
				offenders.push(
					`registerGatewayHandler("${h.method}", ...): touches sessionKey/agentId but does not call sessionsAccessCheck / checkSessionToolAccess`,
				);
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`Unguarded registered handlers detected (Wave O0.6 invariant):\n  ${offenders.join(
				"\n  ",
			)}\n\nAdd sessionsAccessCheck(...) inside the handler body or pass\n{accessCheck: sessionsAccessCheck} into the shared session handler. If\nthe method legitimately needs no guard, add it to\nALLOWLIST_NO_GUARD_NEEDED with a justifying comment in this test.`,
		);
	});

	it("known-guarded sessions handlers retain their guard wiring", () => {
		const handlers = parseRegisteredHandlers(src);
		const cases = parseSwitchCases(src);
		const handlerByMethod = new Map(handlers.map((h) => [h.method, h]));
		const caseByMethod = new Map(cases.map((c) => [c.method, c]));
		const broken: string[] = [];
		for (const method of KNOWN_GUARDED_SESSIONS_METHODS) {
			const h = handlerByMethod.get(method);
			const c = caseByMethod.get(method);
			const guarded =
				(h && bodyMentionsGuard(h.body)) || (c && bodyMentionsGuard(c.body));
			if (!guarded) {
				broken.push(
					`expected ${method} to call sessionsAccessCheck / checkSessionToolAccess in its registered handler or switch case`,
				);
			}
		}
		assert.deepStrictEqual(
			broken,
			[],
			`Regression detected — a previously-guarded sessions method lost its guard:\n  ${broken.join(
				"\n  ",
			)}`,
		);
	});
});
