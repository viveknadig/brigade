import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, SEGMENT_DEFAULTS, clampImportance, makeMemoryId } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-facts-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("FactStore — write + list", () => {
	it("derives tier/importance/decay from the segment defaults", () => {
		const store = new FactStore(dir);
		const rec = store.write({ content: "User is on Windows.", segment: "identity" });
		assert.equal(rec.segment, "identity");
		assert.equal(rec.tier, SEGMENT_DEFAULTS.identity.tier); // permanent
		assert.equal(rec.importance, SEGMENT_DEFAULTS.identity.importance); // 0.85
		assert.equal(rec.decayRate, SEGMENT_DEFAULTS.identity.decayRate);
		assert.equal(rec.lifecycle, "active");
		assert.equal(rec.accessCount, 0);
		assert.ok(rec.memoryId.startsWith("mem_"));
		// Persisted + listable.
		assert.equal(store.list().length, 1);
		assert.equal(store.list({ segment: "identity" })[0]?.content, "User is on Windows.");
	});

	it("clamps an out-of-range importance override", () => {
		const store = new FactStore(dir);
		const hi = store.write({ content: "x", segment: "context", importance: 5 });
		const lo = store.write({ content: "y", segment: "context", importance: -1 });
		assert.equal(hi.importance, 1);
		assert.equal(lo.importance, 0);
	});

	it("supersede archives the prior record (correction overwrites belief)", () => {
		const store = new FactStore(dir);
		const old = store.write({ content: "User likes tabs.", segment: "preference" });
		store.write({
			content: "User actually prefers spaces.",
			segment: "correction",
			supersedes: [old.memoryId],
			metadata: { corrects: "User likes tabs." },
		});
		// Active list shows only the correction; the old one is archived.
		const active = store.list();
		assert.equal(active.length, 1);
		assert.equal(active[0]?.segment, "correction");
		assert.equal(store.list({ lifecycle: "archived" }).length, 1);
	});

	it("markAccessed bumps accessCount + lastAccessedAt", () => {
		const store = new FactStore(dir);
		const r = store.write({ content: "fact", segment: "knowledge" });
		const before = r.lastAccessedAt;
		store.markAccessed([r.memoryId]);
		const after = store.list()[0];
		assert.equal(after?.accessCount, 1);
		assert.ok((after?.lastAccessedAt ?? 0) >= before);
	});

	it("setLifecycle prunes records (decay GC seam)", () => {
		const store = new FactStore(dir);
		const r = store.write({ content: "stale", segment: "context" });
		store.setLifecycle([r.memoryId], "pruned");
		assert.equal(store.list().length, 0);
		assert.equal(store.list({ lifecycle: "pruned" }).length, 1);
	});

	it("skips corrupt JSONL lines without throwing", () => {
		const store = new FactStore(dir);
		store.write({ content: "good", segment: "knowledge" });
		fs.appendFileSync(store.filePath, "this is not json\n", "utf8");
		const all = store.readAll();
		assert.equal(all.length, 1);
		assert.equal(all[0]?.content, "good");
	});

	it("empty / missing store reads as []", () => {
		const store = new FactStore(dir);
		assert.deepEqual(store.readAll(), []);
		assert.deepEqual(store.list(), []);
	});
});

describe("record helpers", () => {
	it("clampImportance falls back when not finite", () => {
		assert.equal(clampImportance(undefined, 0.5), 0.5);
		assert.equal(clampImportance(Number.NaN, 0.7), 0.7);
		assert.equal(clampImportance(0.3, 0.5), 0.3);
	});
	it("makeMemoryId is unique-ish + prefixed", () => {
		const a = makeMemoryId();
		const b = makeMemoryId();
		assert.notEqual(a, b);
		assert.ok(a.startsWith("mem_"));
	});
});
