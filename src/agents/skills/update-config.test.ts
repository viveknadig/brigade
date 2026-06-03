/**
 * Tests for the pure config-mutation helper behind `skills.update`.
 *
 * Verifies the enabled toggle, apiKey set/clear, env upsert/delete, and
 * that the existing config is not mutated (the helper must return a new
 * top-level object so the gateway handler can persist via saveConfig).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import { applySkillUpdate } from "./update-config.js";

describe("applySkillUpdate", () => {
	it("toggles enabled=false on a previously-unset entry (RPC contract)", () => {
		const before: BrigadeConfig = {};
		const { config: after, entry } = applySkillUpdate(before, {
			name: "gh",
			enabled: false,
		});
		assert.equal(after.skills?.entries?.gh?.enabled, false);
		assert.equal(entry.enabled, false);
		// Source config unchanged (no in-place mutation).
		assert.equal(before.skills, undefined);
	});

	it("preserves other entries when patching one", () => {
		const before: BrigadeConfig = {
			skills: { entries: { other: { enabled: true } } },
		};
		const { config: after } = applySkillUpdate(before, { name: "gh", enabled: false });
		assert.equal(after.skills?.entries?.other?.enabled, true);
		assert.equal(after.skills?.entries?.gh?.enabled, false);
	});

	it("sets apiKey when supplied and deletes it when empty", () => {
		const set = applySkillUpdate({}, { name: "gh", apiKey: "abc" });
		assert.equal(
			(set.config.skills?.entries?.gh as { apiKey?: string })?.apiKey,
			"abc",
		);
		const clear = applySkillUpdate(set.config, { name: "gh", apiKey: "  " });
		assert.equal(
			(clear.config.skills?.entries?.gh as { apiKey?: string })?.apiKey,
			undefined,
		);
	});

	it("upserts env keys and removes keys whose value is empty", () => {
		const seeded = applySkillUpdate({}, {
			name: "gh",
			env: { GH_TOKEN: "tok", OTHER: "y" },
		});
		assert.deepEqual(
			(seeded.config.skills?.entries?.gh as { env?: Record<string, string> })?.env,
			{ GH_TOKEN: "tok", OTHER: "y" },
		);
		const cleared = applySkillUpdate(seeded.config, {
			name: "gh",
			env: { OTHER: " " },
		});
		assert.deepEqual(
			(cleared.config.skills?.entries?.gh as { env?: Record<string, string> })?.env,
			{ GH_TOKEN: "tok" },
		);
	});

	it("throws when name is empty/whitespace", () => {
		assert.throws(() => applySkillUpdate({}, { name: "" }), /name is required/);
		assert.throws(() => applySkillUpdate({}, { name: "   " }), /name is required/);
	});
});
