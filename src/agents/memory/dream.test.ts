import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runDream } from "./dream.js";
import { FactStore } from "./records.js";

/**
 * Tideline Step 22 — the nightly dream. The done-when from the plan: "a 3×
 * repeated correction becomes a confirmed preference and the index updates."
 * Plus: consolidation merges near-identical duplicates, and eviction NEVER
 * touches a confirmed belief.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-dream-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("dream — confirm (the done-when)", () => {
	it("a belief asserted 3× is promoted to a confirmed preference", () => {
		const store = new FactStore(dir);
		// Assert the SAME preference three times → restate-reinforce bumps accessCount.
		store.write({ content: "I prefer spaces over tabs", segment: "preference", subjectKey: "indent" });
		store.write({ content: "I prefer spaces over tabs", segment: "preference", subjectKey: "indent" });
		store.write({ content: "I prefer spaces over tabs", segment: "preference", subjectKey: "indent" });

		const before = store.list().find((r) => r.subjectKey === "indent");
		assert.notEqual(before?.status, "confirmed", "not confirmed before the dream");

		const result = runDream(store, { now: 2_000_000, evictMinAgeMs: Number.POSITIVE_INFINITY });
		assert.equal(result.confirmed.length, 1, "exactly one belief confirmed");

		const after = store.list().find((r) => r.subjectKey === "indent");
		assert.equal(after?.status, "confirmed", "the 3×-asserted belief is now confirmed");
		assert.ok((after?.confidence ?? 0) >= 0.9, "confidence raised");
	});

	it("a subject CORRECTED to new values 3× is confirmed too (correction-chain, not just reinforcement)", () => {
		const store = new FactStore(dir);
		// Four writes, each a DIFFERENT value → each supersedes the prior → 3 archived corrections.
		store.write({ content: "deploy day is Monday", segment: "preference", subjectKey: "day" });
		store.write({ content: "deploy day is Tuesday", segment: "preference", subjectKey: "day" });
		store.write({ content: "deploy day is Wednesday", segment: "preference", subjectKey: "day" });
		store.write({ content: "deploy day is Thursday", segment: "preference", subjectKey: "day" });
		const archived = store.readAll().filter((r) => r.lifecycle !== "active" && r.subjectKey === "day");
		assert.equal(archived.length, 3, "3 archived predecessors (3 corrections)");

		const result = runDream(store, { now: Date.now(), evictMinAgeMs: Number.POSITIVE_INFINITY });
		assert.equal(result.confirmed.length, 1, "the corrected-3× belief is confirmed");
		const active = store.list().find((r) => r.subjectKey === "day");
		assert.equal(active?.status, "confirmed");
		assert.match(active?.content ?? "", /Thursday/, "the LATEST value is the confirmed one");
	});

	it("a belief asserted only once is NOT confirmed", () => {
		const store = new FactStore(dir);
		store.write({ content: "I am trying out vim", segment: "preference", subjectKey: "editor" });
		const result = runDream(store, { now: 2_000_000, evictMinAgeMs: Number.POSITIVE_INFINITY });
		assert.equal(result.confirmed.length, 0, "single assertion stays unconfirmed");
		assert.notEqual(store.list()[0]?.status, "confirmed");
	});
});

describe("dream — consolidate", () => {
	it("merges two near-identical active facts (kept ← duplicate)", () => {
		const store = new FactStore(dir);
		// Identical content tagged under DIFFERENT slots → both escape write-time
		// slot-supersede + dedup and coexist; the dream's cosine pass merges them.
		store.write({ content: "I love jazz", segment: "preference", subjectKey: "music_a" });
		store.write({ content: "I love jazz", segment: "preference", subjectKey: "music_b" });
		assert.equal(store.list().length, 2, "two coexist before the dream");

		const result = runDream(store, {
			now: 2_000_000,
			confirmCount: 99, // don't confirm
			evictMinAgeMs: Number.POSITIVE_INFINITY, // don't evict
		});
		assert.equal(result.consolidated.length, 1, "the duplicate was merged");
		assert.equal(store.list().length, 1, "one active fact remains");
	});
});

describe("dream — evict never touches confirmed", () => {
	it("archives decayed non-confirmed facts but protects the confirmed belief", () => {
		const store = new FactStore(dir);
		// One belief asserted 3× (→ will confirm); one throwaway context fact.
		store.write({ content: "my deploy day is Tuesday", segment: "preference", subjectKey: "deploy_day" });
		store.write({ content: "my deploy day is Tuesday", segment: "preference", subjectKey: "deploy_day" });
		store.write({ content: "my deploy day is Tuesday", segment: "preference", subjectKey: "deploy_day" });
		store.write({ content: "the build ran at 3pm today", segment: "context" });

		// evictBelowScore 1.0 + age 0 ⇒ EVERYTHING is eviction-eligible by score;
		// only the confirmed belief must survive. `now` must be ≥ the facts'
		// real createdAt (they were just written at Date.now()) for the age gate.
		const result = runDream(store, {
			now: Date.now() + 1000,
			evictBelowScore: 1.0,
			evictMinAgeMs: 0,
		});
		assert.equal(result.confirmed.length, 1, "the deploy_day belief confirmed");
		assert.ok(result.evicted.length >= 1, "the throwaway context fact evicted");

		const survivors = store.list();
		assert.ok(
			survivors.some((r) => r.subjectKey === "deploy_day" && r.status === "confirmed"),
			"the confirmed belief survived eviction",
		);
		assert.ok(
			!survivors.some((r) => r.segment === "context"),
			"the decayed context fact was evicted",
		);
	});
});
