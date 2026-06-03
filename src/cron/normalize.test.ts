import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	coerceScheduleInput,
	defaultCronJobCreate,
} from "./normalize.js";
import type { CronJobCreate } from "./types.js";

describe("coerceScheduleInput — ISO + epoch + atMs acceptance", () => {
	it("accepts schedule.at as number (epoch ms) — back-compat", () => {
		const s = coerceScheduleInput({ kind: "at", at: 1_735_689_600_000 });
		assert.deepEqual(s, { kind: "at", at: 1_735_689_600_000 });
	});

	it("accepts schedule.at as ISO-8601 string with Z", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31T23:59:00Z" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("accepts schedule.at as bare date — UTC midnight fallback", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 0, 0, 0));
	});

	it("accepts schedule.at as naive date-time — UTC fallback", () => {
		const s = coerceScheduleInput({ kind: "at", at: "2026-12-31T23:59:00" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, Date.UTC(2026, 11, 31, 23, 59, 0));
	});

	it("accepts atMs as string (digit form)", () => {
		const s = coerceScheduleInput({ kind: "at", atMs: "1735689600000" });
		assert.equal(s.kind, "at");
		if (s.kind !== "at") throw new Error("unreachable");
		assert.equal(s.at, 1_735_689_600_000);
	});

	it("infers kind:at from a bare ISO string on .at when kind omitted", () => {
		const s = coerceScheduleInput({ at: "2026-12-31T23:59:00Z" });
		assert.equal(s.kind, "at");
	});

	it("throws on malformed ISO with no fallback", () => {
		assert.throws(
			() => coerceScheduleInput({ kind: "at", at: "not-a-real-date" }),
			/cron schedule kind "at" requires/,
		);
	});
});

describe("defaultCronJobCreate — sessionTarget 'current' resolver", () => {
	function buildAgentTurn(target?: string): CronJobCreate {
		return {
			name: "ctx-test",
			schedule: { kind: "every", everyMs: 60_000 },
			sessionTarget: target as never,
			payload: { kind: "agentTurn", message: "do thing" },
		} as CronJobCreate;
	}

	it("resolves sessionTarget:'current' to session:<sessionKey> when context supplied", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"), {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "session:agent:main:peer-7");
	});

	it("falls back to 'isolated' when no session context is supplied", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"));
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("falls back to 'isolated' when sessionKey is empty / whitespace", () => {
		const defaulted = defaultCronJobCreate(buildAgentTurn("current"), {
			sessionContext: { sessionKey: "   " },
		});
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("throws on path-special sessionKey ('/') even when 'current' is requested", () => {
		assert.throws(
			() =>
				defaultCronJobCreate(buildAgentTurn("current"), {
					sessionContext: { sessionKey: "evil/../escape" },
				}),
			/path separators|InvalidCronSessionTargetIdError|must not/,
		);
	});

	it("does NOT auto-pick 'current' when sessionTarget is omitted", () => {
		// Default policy: agentTurn → isolated (NOT current). Operator must
		// opt in to session binding explicitly.
		const create: CronJobCreate = {
			name: "no-target",
			schedule: { kind: "every", everyMs: 60_000 },
			payload: { kind: "agentTurn", message: "x" },
		} as CronJobCreate;
		const defaulted = defaultCronJobCreate(create, {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "isolated");
	});

	it("leaves explicit 'session:<id>' untouched", () => {
		const create = buildAgentTurn("session:project-alpha");
		const defaulted = defaultCronJobCreate(create, {
			sessionContext: { sessionKey: "agent:main:peer-7" },
		});
		assert.equal(defaulted.sessionTarget, "session:project-alpha");
	});
});

describe("defaultCronJobCreate — relative 'in N' schedule resolver", () => {
	// Regression for the production "remind me in 5 minutes" bug: the model
	// emitted a wrong 13-digit epoch (a 5-minute reminder scheduled ~14 minutes
	// out), so the cron fired late / the operator never saw it. The relative
	// form lets the model say the OFFSET and the server computes the exact
	// absolute fire time against `nowMs`.
	const NOW = 1_700_000_000_000;
	function relCreate(schedule: unknown): CronJobCreate {
		return {
			name: "rel-test",
			schedule: schedule as never,
			sessionTarget: "isolated",
			payload: { kind: "agentTurn", message: "drink water" },
		} as CronJobCreate;
	}
	function resolvedAt(schedule: unknown): number {
		const defaulted = defaultCronJobCreate(relCreate(schedule), { nowMs: NOW });
		assert.equal(defaulted.schedule.kind, "at");
		if (defaulted.schedule.kind !== "at") throw new Error("unreachable");
		return defaulted.schedule.at;
	}

	it("resolves {kind:'in', inMinutes:5} to now + 5min (the drink-water case)", () => {
		assert.equal(resolvedAt({ kind: "in", inMinutes: 5 }), NOW + 5 * 60_000);
	});

	it("resolves a bare {inSeconds:90} (no kind) to now + 90s", () => {
		assert.equal(resolvedAt({ inSeconds: 90 }), NOW + 90_000);
	});

	it("accepts inMs directly", () => {
		assert.equal(resolvedAt({ inMs: 300_000 }), NOW + 300_000);
	});

	it("sums multiple relative fields ({inHours:1, inMinutes:30} = 90min)", () => {
		assert.equal(resolvedAt({ kind: "in", inHours: 1, inMinutes: 30 }), NOW + 90 * 60_000);
	});

	it("is case-insensitive about field spelling (INMINUTES)", () => {
		assert.equal(resolvedAt({ kind: "in", INMINUTES: 2 } as never), NOW + 2 * 60_000);
	});

	it("leaves an absolute {kind:'at', at:<epoch>} untouched (no relative hijack)", () => {
		const future = NOW + 10 * 60_000;
		assert.equal(resolvedAt({ kind: "at", at: future }), future);
	});

	it("does not hijack an absolute `at` even if a stray relative field is present", () => {
		const future = NOW + 10 * 60_000;
		assert.equal(resolvedAt({ kind: "at", at: future, inMinutes: 5 }), future);
	});

	it("rejects a non-positive relative offset", () => {
		assert.throws(
			() => defaultCronJobCreate(relCreate({ kind: "in", inMinutes: 0 }), { nowMs: NOW }),
			/offset must be positive/,
		);
	});

	it("rejects kind:'in' with no offset field", () => {
		assert.throws(
			() => defaultCronJobCreate(relCreate({ kind: "in" }), { nowMs: NOW }),
			/requires a positive offset/,
		);
	});
});
