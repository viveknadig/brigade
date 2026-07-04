/**
 * Redactor tests — Google `AQ.` / `AIza` key handling across BOTH redactors:
 * the cron-summary redactor (`redact.ts`) and the sessions/history redactor
 * (`agents/tools/sessions/shared.ts`) — plus the false-positive guard that
 * keeps dotted identifiers (`com.AQ.<name>`) out of the redaction.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { redactSensitiveText as redactSession } from "../agents/tools/sessions/shared.js";
import { redactSensitiveText as redactLog } from "./redact.js";

// A realistic-shaped Google AQ. key (base64url body, ≥30 chars).
const AQ_KEY = "AQ.Ab8RN6K7pQ2wXyZ0aB1cD2eF3gH4iJ5kL6mN7oP";
// A legit dotted identifier a naive `AQ.\w{30,}` would wrongly redact: AQ is
// preceded by a dot (the tightened lookbehind must skip it), and its tail is
// <40 chars so the standalone-base64 rule doesn't grab it either.
const DOTTED_IDENT = "com.AQ.serviceRegistryFactoryBeanConfig12";

describe("redact.ts (cron summariser) — Google keys", () => {
	it("redacts a standalone AQ. key", () => {
		assert.match(redactLog(AQ_KEY), /<redacted:provider-key>/);
		assert.doesNotMatch(redactLog(AQ_KEY), /Ab8RN6/);
	});
	it("redacts a key in an assignment (VAR=AQ.…)", () => {
		assert.match(redactLog(`GEMINI=${AQ_KEY}`), /<redacted:provider-key>/);
	});
	it("does NOT redact a dotted identifier like com.AQ.<name> (false-positive guard)", () => {
		assert.strictEqual(redactLog(DOTTED_IDENT), DOTTED_IDENT);
	});
});

describe("sessions/shared.ts (history redactor) — Google keys now caught (#65)", () => {
	it("redacts an AQ. key in transcript text — the leak the fix targeted", () => {
		assert.match(redactSession(`answer: ${AQ_KEY}`), /\[redacted\]/);
		assert.doesNotMatch(redactSession(`answer: ${AQ_KEY}`), /Ab8RN6/);
	});
	it("redacts a legacy AIza key too", () => {
		assert.match(redactSession(`AIza${"C".repeat(35)}`), /\[redacted\]/);
	});
	it("leaves a dotted identifier alone (false-positive guard)", () => {
		assert.strictEqual(redactSession(DOTTED_IDENT), DOTTED_IDENT);
	});
});
