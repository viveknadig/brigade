import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { effectiveScore, runDecayGc } from "./decay.js";
import { FactStore, type MemoryRecord } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-decay-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const DAY = 86_400_000;

function rec(over: Partial<MemoryRecord>): MemoryRecord {
	return {
		memoryId: "m",
		content: "x",
		segment: "context",
		tier: "short",
		importance: 0.4,
		decayRate: 0.08,
		accessCount: 0,
		lastAccessedAt: Date.now(),
		createdAt: Date.now(),
		lifecycle: "active",
		...over,
	};
}

describe("effectiveScore", () => {
	it("permanent tier never decays (always 1)", () => {
		const r = rec({ tier: "permanent", lastAccessedAt: Date.now() - 1000 * DAY });
		assert.equal(effectiveScore(r), 1);
	});
	it("fresh fact ~ its importance; old fact decays below it", () => {
		const now = Date.now();
		const fresh = effectiveScore(rec({ importance: 0.7, lastAccessedAt: now }), now);
		const old = effectiveScore(rec({ importance: 0.7, lastAccessedAt: now - 60 * DAY }), now);
		assert.ok(fresh > old, "older fact scores lower");
		assert.ok(old < 0.7, "decayed below original importance");
	});
	it("recall reinforcement raises the score", () => {
		const now = Date.now();
		const cold = effectiveScore(rec({ accessCount: 0, lastAccessedAt: now - 10 * DAY }), now);
		const warm = effectiveScore(rec({ accessCount: 20, lastAccessedAt: now - 10 * DAY }), now);
		assert.ok(warm > cold);
	});
});

describe("runDecayGc", () => {
	it("prunes a long-neglected low-importance context fact, keeps a fresh one", () => {
		const store = new FactStore(dir);
		const fresh = store.write({ content: "fresh", segment: "context" });
		const stale = store.write({ content: "stale", segment: "context" });
		// Backdate the stale one far past the prune threshold.
		const all = store.readAll();
		const target = all.find((r) => r.memoryId === stale.memoryId)!;
		target.lastAccessedAt = Date.now() - 365 * DAY;
		fs.writeFileSync(store.filePath, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

		const res = runDecayGc(dir);
		assert.ok(res.pruned + res.archived >= 1, "stale fact was archived or pruned");
		const active = store.list();
		assert.ok(active.some((r) => r.memoryId === fresh.memoryId), "fresh fact kept");
		assert.ok(!active.some((r) => r.memoryId === stale.memoryId), "stale fact removed from active");
	});

	it("never touches permanent (identity) facts", () => {
		const store = new FactStore(dir);
		const id = store.write({ content: "User is Bhasvanth.", segment: "identity" }); // permanent
		const all = store.readAll();
		all[0]!.lastAccessedAt = Date.now() - 1000 * DAY;
		fs.writeFileSync(store.filePath, all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
		runDecayGc(dir);
		assert.ok(store.list().some((r) => r.memoryId === id.memoryId), "identity fact survives");
	});
});
