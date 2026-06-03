/**
 * Store persistence — load/save/repair/.bak rotation/perms.
 *
 * Tempdir-isolated; never touches ~/.brigade. Skip mode-perm assertion on
 * Windows because NTFS does not honour POSIX mode bits the way Linux/macOS
 * do (the chmod call is best-effort and silently no-ops).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	ensureLoaded,
	loadCronStore,
	loadCronStoreWithRepairFlag,
	saveCronStore,
} from "./store.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { createCronServiceState } from "./state.js";
import type { CronJob, CronStoreFile } from "../types.js";

function tmpStore(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `brigade-cron-store-${prefix}-`));
	return path.join(dir, "cron.json");
}

function buildJob(overrides: Partial<CronJob> = {}): CronJob {
	const nowMs = Date.now();
	return {
		id: "job-1",
		name: "test",
		enabled: true,
		schedule: { kind: "every", everyMs: 60_000 },
		sessionTarget: "isolated",
		payload: { kind: "agentTurn", message: "hi" },
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		state: {},
		...overrides,
	};
}

describe("store — loadCronStore", () => {
	it("missing file → empty store", () => {
		const p = tmpStore("missing");
		const out = loadCronStore(p);
		assert.equal(out.jobs.length, 0);
		assert.equal(out.version, 1);
	});

	it("malformed JSON → empty store (no throw)", () => {
		const p = tmpStore("malformed");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "{not valid json}", "utf8");
		const out = loadCronStore(p);
		assert.equal(out.jobs.length, 0);
	});

	it("empty file → empty store", () => {
		const p = tmpStore("empty");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "", "utf8");
		const out = loadCronStore(p);
		assert.equal(out.jobs.length, 0);
	});

	it("rejects jobs with grossly-broken shape (missing required fields)", () => {
		const p = tmpStore("broken-shape");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({ version: 1, jobs: [{ id: "x" }] }),
			"utf8",
		);
		const out = loadCronStore(p);
		assert.equal(out.jobs.length, 0);
	});
});

describe("store — schedule repair on load", () => {
	it("bare-string schedule gets coerced to canonical {kind:'cron', expr}", () => {
		const p = tmpStore("string-schedule");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const jobOnDisk = {
			id: "job-1",
			name: "old",
			enabled: true,
			schedule: "0 9 * * *", // legacy bare string
			sessionTarget: "isolated",
			payload: { kind: "agentTurn", message: "hi" },
			state: {},
			createdAtMs: 1,
			updatedAtMs: 1,
		};
		fs.writeFileSync(
			p,
			JSON.stringify({ version: 1, jobs: [jobOnDisk] }),
			"utf8",
		);
		const result = loadCronStoreWithRepairFlag(p);
		assert.equal(result.repaired, true);
		assert.equal(result.store.jobs.length, 1);
		const sched = result.store.jobs[0]!.schedule;
		assert.equal(typeof sched, "object");
		assert.equal((sched as { kind: string }).kind, "cron");
	});

	it("ensureLoaded persists the canonical form so a string schedule lands as an object on disk", async () => {
		const p = tmpStore("repair-persist");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({
				version: 1,
				jobs: [
					{
						id: "job-2",
						name: "old",
						enabled: true,
						schedule: "0 8 * * *",
						sessionTarget: "isolated",
						payload: { kind: "agentTurn", message: "hi" },
						state: {},
						createdAtMs: 1,
						updatedAtMs: 1,
					},
				],
			}),
			"utf8",
		);
		const state = createCronServiceState({
			storePath: p,
			deps: { log: createSubsystemLogger("cron-store-test") },
		});
		await ensureLoaded(state);
		// After ensureLoaded the on-disk shape is canonicalised: the bare
		// string schedule has been rewritten as `{kind: "cron", expr: ...}`.
		// Subsequent loads see the canonical-object schedule.
		const second = loadCronStoreWithRepairFlag(p);
		assert.equal(second.store.jobs.length, 1);
		const sched = second.store.jobs[0]!.schedule;
		assert.equal(typeof sched, "object");
		assert.equal((sched as { kind: string }).kind, "cron");
		assert.equal((sched as { expr: string }).expr, "0 8 * * *");
	});
});

describe("store — saveCronStore", () => {
	it(".bak rotation copies previous file before overwrite", () => {
		const p = tmpStore("bak-rotation");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const first: CronStoreFile = { version: 1, jobs: [buildJob({ id: "v1" })] };
		saveCronStore(p, first);
		// Now write a second version.
		const second: CronStoreFile = { version: 1, jobs: [buildJob({ id: "v2" })] };
		saveCronStore(p, second);
		const bakPath = `${p}.bak`;
		assert.ok(fs.existsSync(bakPath), ".bak file should exist after rotation");
		const bakContents = JSON.parse(fs.readFileSync(bakPath, "utf8")) as CronStoreFile;
		assert.equal(bakContents.jobs[0]!.id, "v1", ".bak holds the previous-write contents");
	});

	const isWindows = process.platform === "win32";
	it("posix 0o600 perms on the saved store (skip on Windows)", { skip: isWindows }, () => {
		const p = tmpStore("perms");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const store: CronStoreFile = { version: 1, jobs: [buildJob()] };
		saveCronStore(p, store);
		const stat = fs.statSync(p);
		// 0o600 means user rw, group/other none.
		const mode = stat.mode & 0o777;
		assert.equal(mode, 0o600, `expected 0o600 perms, got ${mode.toString(8)}`);
	});

	it("first-ever write skips .bak (nothing to back up)", () => {
		const p = tmpStore("first-write");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const store: CronStoreFile = { version: 1, jobs: [buildJob()] };
		saveCronStore(p, store);
		assert.ok(!fs.existsSync(`${p}.bak`), "no .bak on the very first save");
	});
});

describe("store — every-schedule anchor stability", () => {
	it("stamps a stable anchor on a legacy anchor-less `every` job (self-heals drift)", () => {
		const p = tmpStore("every-anchor-migrate");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const jobOnDisk = {
			id: "every-legacy",
			name: "hourly",
			enabled: true,
			schedule: { kind: "every", everyMs: 3_600_000 }, // legacy: no anchorMs
			sessionTarget: "isolated",
			payload: { kind: "agentTurn", message: "hi" },
			state: { nextRunAtMs: 123 },
			createdAtMs: 1_700_000_000_000,
			updatedAtMs: 1_700_000_000_000,
		};
		fs.writeFileSync(p, JSON.stringify({ version: 1, jobs: [jobOnDisk] }), "utf8");
		const result = loadCronStoreWithRepairFlag(p);
		assert.equal(result.repaired, true, "anchor-less every job is repaired");
		const sched = result.store.jobs[0]!.schedule as { kind: string; anchorMs?: number };
		assert.equal(sched.kind, "every");
		assert.equal(sched.anchorMs, 1_700_000_000_000, "anchor stamped from createdAtMs");
	});

	it("an already-anchored `every` job loads as a no-op and preserves nextRunAtMs", () => {
		// Guards the value-compare fix: a canonical anchored job must NOT be
		// re-"canonicalised" on every load (the old reference check re-persisted
		// + recomputed nextRunAtMs every tick, spamming the log and clobbering
		// stored fire-times).
		const p = tmpStore("every-anchored-noop");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const jobOnDisk = {
			id: "every-anchored",
			name: "hourly",
			enabled: true,
			schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 1_700_000_000_000 },
			sessionTarget: "isolated",
			payload: { kind: "agentTurn", message: "hi" },
			state: { nextRunAtMs: 1_700_003_600_000 },
			createdAtMs: 1_700_000_000_000,
			updatedAtMs: 1_700_000_000_000,
		};
		fs.writeFileSync(p, JSON.stringify({ version: 1, jobs: [jobOnDisk] }), "utf8");
		const result = loadCronStoreWithRepairFlag(p);
		assert.equal(result.repaired, false, "canonical anchored every job is a no-op load");
		assert.equal(
			result.store.jobs[0]!.state.nextRunAtMs,
			1_700_003_600_000,
			"stored nextRunAtMs preserved (not clobbered)",
		);
	});
});
