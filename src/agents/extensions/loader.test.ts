/**
 * Loader-layer tests: activation traceability + skip-reason structured logs.
 *
 * The loader's job here is to surface a stable, structured log line for every
 * module decision so an operator can answer "why didn't my plugin load" from
 * the JSONL log alone. We flip the subsystem logger's console mirror on,
 * capture stderr, and assert the expected `id=`/`reason=`/`cause=` tokens.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Type } from "typebox";
import { Check } from "typebox/value";

import type { BrigadeConfig } from "../../config/io.js";
import { BrigadeConfigSchema, collectBrigadeConfigErrors } from "../../core/brigade-config.js";
import { setConsoleLogging } from "../../logging/subsystem-logger.js";
import { loadModules } from "./loader.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import { defineModule } from "./types.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

const noopRegister = () => undefined;

/** Capture stderr while a block runs; restore the original writer afterwards. */
function captureStderr(): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const orig = process.stderr.write.bind(process.stderr);
	(process.stderr.write as unknown as (s: string | Uint8Array) => boolean) = (s) => {
		chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
		return true;
	};
	return {
		chunks,
		restore: () => {
			process.stderr.write = orig;
		},
	};
}

describe("loadModules — activation traceability", () => {
	let cap: { chunks: string[]; restore: () => void };

	beforeEach(() => {
		// Force the subsystem logger to mirror to stderr regardless of TTY state
		// so the test can observe the structured lines without depending on the
		// runner's terminal kind.
		setConsoleLogging(true);
		cap = captureStderr();
	});

	afterEach(() => {
		cap.restore();
		setConsoleLogging(false);
	});

	it("emits 'extension activated' for a module that loads cleanly", async () => {
		const reg = await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "ok", register: noopRegister })],
			meta: META,
		});
		assert.equal(reg.loadedModules.length, 1);
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension activated/);
		assert.match(out, /id=ok/);
		assert.match(out, /origin=bundled/);
	});

	it("emits skip log with reason=disabled when extensions.disabled[] hits", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "x", register: noopRegister })],
			meta: { ...META, config: { extensions: { disabled: ["x"] } } as unknown as BrigadeConfig },
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=x/);
		assert.match(out, /reason=disabled/);
	});

	it("emits skip log with reason=allowlist when extensions.allow excludes the id", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "blocked", register: noopRegister })],
			meta: { ...META, config: { extensions: { allow: ["other"] } } as unknown as BrigadeConfig },
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=blocked/);
		assert.match(out, /reason=allowlist/);
		assert.match(out, /extensions\.allow does not include this id/);
	});

	it("emits skip log with reason=requiresEnv when an env var is missing", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "envy", requiresEnv: ["NOPE_BRIGADE_XYZ"], register: noopRegister })],
			meta: META,
			env: {},
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=envy/);
		assert.match(out, /reason=requiresEnv/);
		assert.match(out, /NOPE_BRIGADE_XYZ/);
	});

	it("emits skip log with reason=eligible when eligible() returns false", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [defineModule({ id: "elig", eligible: () => false, register: noopRegister })],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=elig/);
		assert.match(out, /reason=eligible/);
	});

	it("emits skip log with reason=configSchema when config fails validation", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "needs-token",
					configSchema: Type.Object({ token: Type.String() }),
					register: noopRegister,
				}),
			],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension skipped/);
		assert.match(out, /id=needs-token/);
		assert.match(out, /reason=configSchema/);
	});

	it("emits skip log with reason=registerFailed when register() throws", async () => {
		await loadModules({
			noDiscovery: true,
			modules: [
				defineModule({
					id: "boom",
					register() {
						throw new Error("nope");
					},
				}),
			],
			meta: META,
		});
		cap.restore();
		const out = cap.chunks.join("");
		assert.match(out, /extension register failed/);
		assert.match(out, /id=boom/);
		assert.match(out, /reason=registerFailed/);
		assert.match(out, /nope/);
	});
});

describe("loadModules — bundled-vs-user origin tracking", () => {
	it("marks a bundled module's activation log with origin=bundled", async () => {
		setConsoleLogging(true);
		const cap = captureStderr();
		try {
			await loadModules({
				noDiscovery: true,
				modules: [defineModule({ id: "bun", register: noopRegister })],
				meta: META,
			});
		} finally {
			cap.restore();
			setConsoleLogging(false);
		}
		const out = cap.chunks.join("");
		assert.match(out, /id=bun/);
		assert.match(out, /origin=bundled/);
	});
});

describe("brigade-config.extensions.slots schema", () => {
	it("accepts a config with extensions.slots.memory set to a string", () => {
		const cfg = {
			version: 2,
			extensions: { slots: { memory: "lancedb" } },
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), true);
		assert.deepEqual(collectBrigadeConfigErrors(cfg), []);
	});

	it("accepts every named slot (memory/contextEngine/compaction/agentHarness)", () => {
		const cfg = {
			version: 2,
			extensions: {
				slots: {
					memory: "lancedb",
					contextEngine: "semantic-window",
					compaction: "llm-summary",
					agentHarness: "codex",
				},
			},
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), true);
	});

	it("rejects an unknown slot key (additionalProperties=false)", () => {
		const cfg = {
			version: 2,
			extensions: { slots: { madeUp: "x" } },
		};
		assert.equal(Check(BrigadeConfigSchema, cfg), false);
	});

	it("resolveSlot picks the capability whose id matches extensions.slots.<name>", () => {
		const reg = new BrigadeExtensionRegistry();
		const cfg = {
			version: 2,
			extensions: { slots: { memory: "wanted" } },
		} as unknown as BrigadeConfig;
		const candidates = [
			{ id: "other", label: "Other" },
			{ id: "wanted", label: "Wanted" },
		];
		const picked = reg.resolveSlot("memory", cfg, candidates);
		assert.equal(picked?.id, "wanted");
	});

	it("resolveSlot returns undefined when the slot is unset (built-in path)", () => {
		const reg = new BrigadeExtensionRegistry();
		const cfg = { version: 2 } as unknown as BrigadeConfig;
		const picked = reg.resolveSlot("memory", cfg, [{ id: "x", label: "X" }]);
		assert.equal(picked, undefined);
	});
});
