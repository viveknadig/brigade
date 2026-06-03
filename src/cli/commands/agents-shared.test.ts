import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agshared-"));
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agents-shared: requireValidConfig", () => {
	it("returns an empty config when brigade.json is absent", async () => {
		const { requireValidConfig } = await import("./agents-shared.js");
		const cfg = await requireValidConfig({
			log: () => {},
			error: () => {},
			warn: () => {},
		});
		assert.notEqual(cfg, null);
		assert.ok(cfg?.agents !== undefined);
	});

	it("returns null + writes a parse error when brigade.json is malformed", async () => {
		writeFileSync(join(stateDir, "brigade.json"), "{ not valid json");
		const messages: string[] = [];
		const { requireValidConfig } = await import("./agents-shared.js");
		const cfg = await requireValidConfig({
			log: () => {},
			error: (m) => messages.push(m),
			warn: () => {},
		});
		assert.equal(cfg, null);
		assert.ok(messages.some((m) => /Config invalid/i.test(m)));
	});
});

describe("agents-shared: createQuietRuntime", () => {
	it("silences log but preserves error / warn", async () => {
		const { createQuietRuntime } = await import("./agents-shared.js");
		let logs = 0;
		let errs = 0;
		let warns = 0;
		const base = {
			log: () => {
				logs += 1;
			},
			error: () => {
				errs += 1;
			},
			warn: () => {
				warns += 1;
			},
		};
		const quiet = createQuietRuntime(base);
		quiet.log("noise");
		quiet.error("loud");
		quiet.warn("medium");
		assert.equal(logs, 0);
		assert.equal(errs, 1);
		assert.equal(warns, 1);
	});
});
