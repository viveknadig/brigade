import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import { collectDiscordSecurityAuditFindings } from "./security-audit.js";
import { isDiscordMutableAllowEntry, scanDiscordNumericIdHazards } from "./security-doctor.js";

describe("isDiscordMutableAllowEntry", () => {
	it("stable ids are NOT mutable", () => {
		assert.equal(isDiscordMutableAllowEntry("123456789012345678"), false);
		assert.equal(isDiscordMutableAllowEntry("<@123>"), false);
		assert.equal(isDiscordMutableAllowEntry("<@!123>"), false);
		assert.equal(isDiscordMutableAllowEntry("user:123"), false);
		assert.equal(isDiscordMutableAllowEntry("pk:abc"), false);
		assert.equal(isDiscordMutableAllowEntry("*"), false);
		assert.equal(isDiscordMutableAllowEntry(""), false);
	});

	it("bare names + empty-prefix entries ARE mutable", () => {
		assert.equal(isDiscordMutableAllowEntry("alex"), true);
		assert.equal(isDiscordMutableAllowEntry("Alex#1234"), true);
		assert.equal(isDiscordMutableAllowEntry("user:"), true);
		assert.equal(isDiscordMutableAllowEntry("@handle"), true);
	});
});

describe("scanDiscordNumericIdHazards", () => {
	it("flags a near-2^53 numeric VALUE as repairable (still lossless)", () => {
		// A large integer still ≤ 2^53-1 → can be losslessly stringified.
		const hazards = scanDiscordNumericIdHazards({ guildId: 9_007_199_254_740_990 });
		assert.equal(hazards.length, 1);
		assert.equal(hazards[0]?.repairable, true);
		assert.equal(hazards[0]?.path, "channels.discord.guildId");
	});

	it("flags a precision-lost snowflake VALUE as NOT repairable", () => {
		// > 2^53 → already lost precision.
		const hazards = scanDiscordNumericIdHazards({ allowFrom: [12345678901234567890] });
		assert.equal(hazards.length, 1);
		assert.equal(hazards[0]?.repairable, false);
	});

	it("ignores small numbers (debounceMs, position, durations)", () => {
		const hazards = scanDiscordNumericIdHazards({ debounceMs: 500, autoArchiveDuration: 1440, position: 3 });
		assert.deepEqual(hazards, []);
	});
});

const cfg = (discord: Record<string, unknown>): BrigadeConfig =>
	({ channels: { discord } }) as unknown as BrigadeConfig;

describe("collectDiscordSecurityAuditFindings", () => {
	it("warns on a name-based allow entry", () => {
		const findings = collectDiscordSecurityAuditFindings({ cfg: cfg({ allowFrom: ["alex", "123456789012345678"] }) });
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.severity, "warn");
		assert.match(findings[0]?.detail ?? "", /alex/);
	});

	it("no finding when every entry is a stable id", () => {
		const findings = collectDiscordSecurityAuditFindings({ cfg: cfg({ allowFrom: ["123456789012345678", "<@456>", "user:789"] }) });
		assert.deepEqual(findings, []);
	});

	it("walks guild + channel user allow-lists", () => {
		const findings = collectDiscordSecurityAuditFindings({
			cfg: cfg({ guilds: { g1: { users: ["mod-name"], channels: { c1: { users: ["another-name"] } } } } }),
		});
		assert.equal(findings.length, 1);
		assert.match(findings[0]?.detail ?? "", /mod-name/);
	});
});
