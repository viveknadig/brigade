/**
 * H5 — `set-model` must preserve `cfg.agents.defaults.model.fallbacks` for
 * per-agent overrides.
 *
 * Before H5, `set-model agentId=scout provider=anthropic modelId=...` would
 * overwrite `cfg.agents.scout.model` with just `{ primary }`, silently
 * dropping the resilient-turn fallback chain. After H5, the handler reads
 * `cfg.agents.defaults.model.fallbacks` and inherits the array into the
 * per-agent entry when the entry has none of its own. If the per-agent
 * entry already declares fallbacks, those are preserved verbatim.
 *
 * Booting the gateway just to test the on-disk shape is impractical;
 * this suite exercises `applySetModelMutationForAgent` directly.
 *
 * Tempdir-isolated; never writes into ~/.brigade or ~/.pi.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applySetModelMutationForAgent } from "./agent-runtime-persist.js";

let stateDir: string;
let prevStateDir: string | undefined;
let prevConfigPath: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-set-model-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	prevConfigPath = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = stateDir;
	delete process.env.BRIGADE_CONFIG_PATH;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	if (prevConfigPath === undefined) delete process.env.BRIGADE_CONFIG_PATH;
	else process.env.BRIGADE_CONFIG_PATH = prevConfigPath;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("H5 set-model: per-agent fallback inheritance", () => {
	it("(a) inherits fallbacks from cfg.agents.defaults when per-agent has none", () => {
		const before = {
			agents: {
				defaults: {
					provider: "anthropic",
					model: {
						primary: "claude-3-5",
						fallbacks: ["claude-3-5-haiku", "gpt-4o"],
					},
				},
				scout: { provider: "anthropic" }, // no model.fallbacks
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"anthropic",
			"claude-opus-4-7",
		);
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		const model = scout.model as { primary: string; fallbacks?: string[] };
		assert.equal(model.primary, "claude-opus-4-7");
		assert.deepEqual(model.fallbacks, ["claude-3-5-haiku", "gpt-4o"]);
	});

	it("(b) preserves per-agent fallbacks when the entry already declares its own", () => {
		const before = {
			agents: {
				defaults: {
					provider: "anthropic",
					model: { primary: "claude-3-5", fallbacks: ["should-not-leak"] },
				},
				scout: {
					provider: "openai",
					model: { primary: "gpt-4", fallbacks: ["gpt-4o-mini", "haiku"] },
				},
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"openai",
			"gpt-4o",
		);
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		const model = scout.model as { primary: string; fallbacks?: string[] };
		assert.equal(model.primary, "gpt-4o");
		assert.deepEqual(
			model.fallbacks,
			["gpt-4o-mini", "haiku"],
			"per-agent fallbacks must win",
		);
	});

	it("(c) defaults has no fallbacks → per-agent entry has none", () => {
		const before = {
			agents: {
				defaults: { provider: "anthropic", model: { primary: "claude-3-5" } },
				scout: { provider: "anthropic" },
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"anthropic",
			"claude-opus-4-7",
		);
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		const model = scout.model as { primary: string; fallbacks?: string[] };
		assert.equal(model.primary, "claude-opus-4-7");
		assert.equal(model.fallbacks, undefined, "must not invent fallbacks");
	});

	it("creates the agent entry when it does not exist yet", () => {
		const before = {
			agents: {
				defaults: {
					provider: "anthropic",
					model: { primary: "claude-3-5", fallbacks: ["haiku"] },
				},
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"anthropic",
			"claude-opus-4-7",
		);
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		assert.equal(scout.provider, "anthropic");
		const model = scout.model as { primary: string; fallbacks?: string[] };
		assert.equal(model.primary, "claude-opus-4-7");
		assert.deepEqual(model.fallbacks, ["haiku"]);
	});

	it("filters non-string entries out of inherited fallbacks", () => {
		// Hand-edited config could ship invalid entries — they must not
		// crash the inheritance path or leak through unchecked. The literal
		// is typed as `unknown[]` so the union doesn't fight BrigadeConfig.
		const before = {
			agents: {
				defaults: {
					provider: "anthropic",
					model: {
						primary: "claude-3-5",
						fallbacks: ["ok", null, 42, "", "ok2"] as unknown as string[],
					},
				},
				scout: { provider: "anthropic" },
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"anthropic",
			"claude-opus-4-7",
		);
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		const model = scout.model as { primary: string; fallbacks?: string[] };
		assert.deepEqual(model.fallbacks, ["ok", "ok2"]);
	});

	it("does not touch defaults.model.fallbacks", () => {
		const before = {
			agents: {
				defaults: {
					provider: "anthropic",
					model: { primary: "claude-3-5", fallbacks: ["a", "b"] },
				},
				scout: { provider: "anthropic" },
			},
		};
		const after = applySetModelMutationForAgent(
			before,
			"scout",
			"anthropic",
			"claude-opus-4-7",
		);
		const defaults = (after.agents as Record<string, Record<string, unknown>>).defaults;
		assert.ok(defaults);
		const dmodel = defaults.model as { primary: string; fallbacks?: string[] };
		assert.equal(dmodel.primary, "claude-3-5");
		assert.deepEqual(dmodel.fallbacks, ["a", "b"]);
	});
});
