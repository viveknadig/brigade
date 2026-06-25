import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { collectDiscordStatusIssues } from "./status-issues.js";

describe("collectDiscordStatusIssues (Phase 5)", () => {
	it("emits an intent warn when MESSAGE CONTENT is disabled", () => {
		const issues = collectDiscordStatusIssues([
			{
				accountId: "default",
				probe: {
					ok: true,
					elapsedMs: 1,
					privilegedIntents: { messageContent: "disabled", guildMembers: "enabled", presence: "enabled" },
				},
			},
		]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.severity, "warn");
		assert.match(issues[0]?.message ?? "", /Message Content Intent is disabled/);
	});

	it("no issue when message content is enabled", () => {
		const issues = collectDiscordStatusIssues([
			{
				accountId: "default",
				probe: { ok: true, elapsedMs: 1, privilegedIntents: { messageContent: "enabled", guildMembers: "enabled", presence: "enabled" } },
			},
		]);
		assert.deepEqual(issues, []);
	});

	it("emits an error per channel that failed the permission audit", () => {
		const issues = collectDiscordStatusIssues([
			{
				accountId: "default",
				audit: {
					unresolvedChannels: 0,
					channels: [
						{ channelId: "100", ok: true, missingRequired: [] },
						{ channelId: "200", ok: false, missingRequired: ["SendMessages"] },
					],
				},
			},
		]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.severity, "error");
		assert.match(issues[0]?.message ?? "", /Channel 200 permission check failed/);
		assert.match(issues[0]?.message ?? "", /missing SendMessages/);
	});

	it("warns when some configured channels weren't numeric ids", () => {
		const issues = collectDiscordStatusIssues([
			{ accountId: "default", audit: { unresolvedChannels: 2, channels: [] } },
		]);
		assert.equal(issues.length, 1);
		assert.equal(issues[0]?.severity, "warn");
		assert.match(issues[0]?.message ?? "", /unresolvedChannels=2/);
	});

	it("skips accounts with no accountId", () => {
		assert.deepEqual(collectDiscordStatusIssues([{ accountId: "" }]), []);
	});
});
