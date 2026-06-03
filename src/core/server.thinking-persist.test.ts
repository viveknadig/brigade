/**
 * H4 — set-thinking persistence + rehydrate.
 *
 * The `set-thinking` RPC writes `cfg.agents.<id>.thinking = <level>` so a
 * daemon restart honours the operator's selection. The boot/seed path
 * (`server.ts → seedAgentsFromConfig`) reads it back via
 * `readPersistedThinkingLevel`; if the persisted string is invalid the
 * runtime falls back to `pickInitialThinkingLevel(model)`.
 *
 * The live RPC handler also mutates `perAgentRuntime` and broadcasts a
 * snapshot — those side effects need the full gateway. This suite tests
 * the pure persistence shape via `applySetThinkingMutation` and the
 * round-trip rehydrate logic via `readPersistedThinkingLevel`.
 *
 * Tempdir-isolated; never writes into ~/.brigade or ~/.pi.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applySetThinkingMutation } from "./agent-runtime-persist.js";
import { readPersistedThinkingLevel, pickInitialThinkingLevel } from "./model-caps.js";
import type { Model } from "@mariozechner/pi-ai";

let stateDir: string;
let prevStateDir: string | undefined;
let prevConfigPath: string | undefined;

function writeConfig(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

function readConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-thinking-"));
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

describe("H4 set-thinking: persistence shape", () => {
	it("writes cfg.agents.<id>.thinking on the target agent only", () => {
		const before = {
			agents: {
				defaults: { provider: "anthropic", model: { primary: "claude-3-5" } },
				main: {},
				scout: { provider: "anthropic" },
			},
		};
		const after = applySetThinkingMutation(before, "scout", "high");
		const agents = (after.agents as Record<string, Record<string, unknown>>) ?? {};
		assert.equal(agents.scout?.thinking, "high");
		// Other agents untouched.
		assert.equal((agents.main as Record<string, unknown>)?.thinking, undefined);
		assert.equal(
			(agents.defaults as Record<string, unknown>)?.thinking,
			undefined,
			"defaults must not be touched",
		);
	});

	it("preserves existing fields on the agent entry (provider / model)", () => {
		const before = {
			agents: {
				scout: { provider: "openai", model: { primary: "gpt-x" } },
			},
		};
		const after = applySetThinkingMutation(before, "scout", "medium");
		const scout = (after.agents as Record<string, Record<string, unknown>>).scout;
		assert.ok(scout);
		assert.equal(scout.provider, "openai");
		assert.deepEqual(scout.model, { primary: "gpt-x" });
		assert.equal(scout.thinking, "medium");
	});

	it("creates the agent entry when it did not exist yet", () => {
		const before = { agents: { main: {} } };
		const after = applySetThinkingMutation(before, "scout", "low");
		const agents = after.agents as Record<string, Record<string, unknown>>;
		assert.equal(agents.scout?.thinking, "low");
	});
});

describe("H4 set-thinking: round-trip persistence + rehydrate", () => {
	it("(a) the persistence shape writes through to disk verbatim", () => {
		writeConfig({ agents: { main: {}, scout: { provider: "anthropic" } } });
		const cur = JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8"));
		const next = applySetThinkingMutation(cur, "scout", "high");
		writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(next, null, 2));
		const persisted = readConfig();
		const scout = (persisted.agents as Record<string, Record<string, unknown>>).scout;
		assert.equal(scout?.thinking, "high");
	});

	it("(b) seedAgentsFromConfig-equivalent read-back yields the persisted level", () => {
		// Replicate the seed-path lookup: given the entry that survived a
		// daemon restart, `readPersistedThinkingLevel` should produce the
		// operator's last selection.
		const entry = { provider: "anthropic", model: { primary: "x" }, thinking: "high" };
		const persisted = readPersistedThinkingLevel(entry);
		assert.equal(persisted, "high");

		// And the seed path's `??` fallback uses the model-derived default
		// only when the persisted value is undefined.
		const fakeModel = { reasoning: false } as unknown as Model<string>;
		const modelDerived = pickInitialThinkingLevel(fakeModel);
		const resolved = persisted ?? modelDerived;
		assert.equal(resolved, "high");
	});

	it("(c) an invalid level string falls through to pickInitialThinkingLevel(model)", () => {
		const entry = { provider: "anthropic", thinking: "EXTREME" };
		const persisted = readPersistedThinkingLevel(entry);
		assert.equal(persisted, undefined, "bogus levels must be rejected");
		const reasoningModel = { reasoning: true } as unknown as Model<string>;
		const fallback = persisted ?? pickInitialThinkingLevel(reasoningModel);
		assert.equal(fallback, "low", "reasoning model fallback is 'low'");

		const plainModel = { reasoning: false } as unknown as Model<string>;
		const fallbackPlain = persisted ?? pickInitialThinkingLevel(plainModel);
		assert.equal(fallbackPlain, "off");
	});

	it("(d) per-agent persisted level does not leak into siblings", () => {
		const before = {
			agents: {
				main: {},
				scout: { provider: "anthropic" },
			},
		};
		const after = applySetThinkingMutation(before, "scout", "minimal");
		const agents = after.agents as Record<string, Record<string, unknown>>;
		// Sibling rehydrate must be undefined → falls through to model default.
		assert.equal(readPersistedThinkingLevel(agents.main), undefined);
		// Scout rehydrate matches the just-written level.
		assert.equal(readPersistedThinkingLevel(agents.scout), "minimal");
	});
});
