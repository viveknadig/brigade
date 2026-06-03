/**
 * Unit tests for the per-agent skill allowlist resolver.
 *
 * Three cases:
 *   1. Per-agent `cfg.agents.<id>.skills` wins over defaults.
 *   2. Per-agent absent → fall through to `cfg.agents.defaults.skills`.
 *   3. Both absent → `undefined` (no restriction).
 *
 * Plus the explicit `[]` deny-all case so the spec is unambiguous.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import {
	isSkillAllowedForAgent,
	resolveEffectiveAgentSkillFilter,
} from "./agent-filter.js";

function makeConfig(input: Record<string, unknown>): BrigadeConfig {
	return input as BrigadeConfig;
}

describe("resolveEffectiveAgentSkillFilter", () => {
	it("returns the per-agent allowlist when set", () => {
		const cfg = makeConfig({
			agents: {
				defaults: { skills: ["alpha", "beta"] },
				ops: { skills: ["gh"] },
			},
		});
		assert.deepEqual(resolveEffectiveAgentSkillFilter(cfg, "ops"), ["gh"]);
	});

	it("falls back to defaults when per-agent is absent", () => {
		const cfg = makeConfig({
			agents: {
				defaults: { skills: ["alpha", "beta"] },
				ops: { workspace: "/tmp/ops" }, // no skills field
			},
		});
		assert.deepEqual(
			resolveEffectiveAgentSkillFilter(cfg, "ops"),
			["alpha", "beta"],
		);
	});

	it("returns undefined when neither per-agent nor defaults are set", () => {
		const cfg = makeConfig({
			agents: {
				defaults: { workspace: "/tmp/x" },
				ops: { workspace: "/tmp/ops" },
			},
		});
		assert.equal(resolveEffectiveAgentSkillFilter(cfg, "ops"), undefined);
	});

	it("treats explicit `[]` as deny-all (not 'fall through')", () => {
		const cfg = makeConfig({
			agents: {
				defaults: { skills: ["alpha", "beta"] },
				ops: { skills: [] },
			},
		});
		assert.deepEqual(resolveEffectiveAgentSkillFilter(cfg, "ops"), []);
	});

	it("normalises non-strings + empties out of the list", () => {
		const cfg = makeConfig({
			agents: {
				ops: { skills: ["  gh ", "", null, 42, " jq"] },
			},
		});
		assert.deepEqual(resolveEffectiveAgentSkillFilter(cfg, "ops"), ["gh", "jq"]);
	});

	it("returns undefined when the agent is unknown AND defaults are absent", () => {
		const cfg = makeConfig({ agents: { other: { skills: ["x"] } } });
		assert.equal(resolveEffectiveAgentSkillFilter(cfg, "missing"), undefined);
	});

	it("returns undefined when the whole config is empty", () => {
		assert.equal(resolveEffectiveAgentSkillFilter({}, "ops"), undefined);
		assert.equal(resolveEffectiveAgentSkillFilter(undefined, "ops"), undefined);
	});
});

describe("isSkillAllowedForAgent", () => {
	it("is permissive when allowlist is undefined", () => {
		assert.equal(isSkillAllowedForAgent("anything", undefined), true);
	});
	it("denies all when allowlist is empty", () => {
		assert.equal(isSkillAllowedForAgent("gh", []), false);
	});
	it("admits names in the allowlist", () => {
		assert.equal(isSkillAllowedForAgent("gh", ["gh", "jq"]), true);
		assert.equal(isSkillAllowedForAgent("other", ["gh", "jq"]), false);
	});
});
