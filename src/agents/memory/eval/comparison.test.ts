import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "../records.js";
import {
	defaultRecallCapability,
	ftsBaselineCapability,
	hybridRecallCapability,
	linearScanCapability,
	oracleCapability,
} from "./capabilities.js";
import { SYNTHETIC_GOLD } from "./gold-synthetic.js";
import { seedGold } from "./gold.js";
import { formatRecallEval, runRecallEval } from "./harness.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-compare-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("Step 8 — BM25 (FactStore.search) vs the linear floor", () => {
	it("recall@k and MRR: BM25 ≥ the floor on the synthetic gold", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		// Small cutoff so ranking (not just retrieval) is in play — though on this
		// clean synthetic gold every lane ranks the relevant facts perfectly, so the
		// assertions below are a non-regression floor, not a discriminating ranking test.
		const K = 3;

		const floor = await runRecallEval(linearScanCapability(store), cases, { k: K, clock: () => 0 });
		const fts = await runRecallEval(ftsBaselineCapability(store), cases, { k: K, clock: () => 0 });
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });

		// Surface ALL THREE baselines + the production scorer — these print on
		// `--test` and are the numbers we read together (Step 3 done-when).
		console.log(`\n[baseline i  · linear-scan floor]\n${formatRecallEval(floor)}`);
		console.log(`\n[baseline iii · plain-lexical FTS (no modulation)]\n${formatRecallEval(fts)}`);
		console.log(`\n[Tideline v1 · BM25 × effectiveScore]\n${formatRecallEval(bm25)}`);
		console.log(`\n[baseline ii · full-context oracle]\n${formatRecallEval(oracle)}`);

		assert.ok(bm25.recallAtK > 0 && bm25.mrr > 0, "BM25 finds + ranks relevant facts");
		assert.ok(
			bm25.recallAtK >= floor.recallAtK - 1e-9,
			`BM25 recall@${K} (${bm25.recallAtK.toFixed(3)}) should be ≥ floor (${floor.recallAtK.toFixed(3)})`,
		);
		assert.ok(
			bm25.mrr >= floor.mrr - 1e-9,
			`BM25 MRR (${bm25.mrr.toFixed(3)}) should be ≥ floor (${floor.mrr.toFixed(3)})`,
		);
		// The plain-FTS baseline (pure BM25) must also clear the crude floor, and
		// the production scorer (modulated) must not fall below plain FTS.
		assert.ok(
			fts.recallAtK >= floor.recallAtK - 1e-9,
			`plain-FTS recall@${K} (${fts.recallAtK.toFixed(3)}) should be ≥ floor (${floor.recallAtK.toFixed(3)})`,
		);
		assert.ok(
			bm25.recallAtK >= fts.recallAtK - 1e-9,
			`modulation must not cost recall: BM25×eff (${bm25.recallAtK.toFixed(3)}) ≥ plain-FTS (${fts.recallAtK.toFixed(3)})`,
		);
	});

	it("states the crossover: the index beats the full-context oracle at every realistic budget", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		// The oracle stuffs EVERYTHING into context — perfect recall only once the
		// budget k reaches the corpus size; below that it dilutes the top-k with
		// irrelevant facts. The index's job is to win at realistic budgets.
		const budgets = [1, 3, 5];
		const crossover: string[] = [];
		for (const k of budgets) {
			const idx = await runRecallEval(defaultRecallCapability(store), cases, { k, clock: () => 0 });
			const orc = await runRecallEval(oracleCapability(store), cases, { k, clock: () => 0 });
			crossover.push(`k=${k}: index recall@k=${(idx.recallAtK * 100).toFixed(0)}% vs oracle=${(orc.recallAtK * 100).toFixed(0)}%`);
			assert.ok(
				idx.recallAtK >= orc.recallAtK - 1e-9,
				`at k=${k} the index (${idx.recallAtK.toFixed(3)}) should be ≥ the full-context oracle (${orc.recallAtK.toFixed(3)})`,
			);
		}
		console.log(`\n[crossover — index vs full-context oracle]\n  ${crossover.join("\n  ")}`);
		console.log(
			"  → On the synthetic gold the index beats the full-context oracle at every realistic budget (k≤5);\n" +
				"    they converge only when k reaches the corpus size (oracle = perfect recall by stuffing everything).\n" +
				"    The true hybrid-vs-oracle crossover on REAL data is the v2 measurement (vectors deferred per 0.2).",
		);
	});

	it("at k ≥ corpus the oracle reaches the recall ceiling (1.0), BM25 ≤ it", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD);
		const K = 20; // ≥ active corpus size
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const oracle = await runRecallEval(oracleCapability(store), cases, { k: K, clock: () => 0 });
		assert.ok(Math.abs(oracle.recallAtK - 1) < 1e-9, "oracle returns everything → perfect recall at large k");
		assert.ok(oracle.recallAtK >= bm25.recallAtK - 1e-9, "oracle is the recall ceiling");
	});

	it("multi-signal hybrid (what recall() serves) does not REGRESS recall@k vs pure BM25", async () => {
		const store = new FactStore(dir);
		const cases = seedGold(store, SYNTHETIC_GOLD); // embed-on-write populates HRR vectors
		const K = 3;
		const bm25 = await runRecallEval(defaultRecallCapability(store), cases, { k: K, clock: () => 0 });
		const hybrid = await runRecallEval(hybridRecallCapability(store), cases, { k: K, clock: () => 0 });
		console.log(`\n[multi-signal hybrid · recall() = BM25⊕HRR × trust × decay]\n${formatRecallEval(hybrid)}`);
		assert.ok(
			hybrid.recallAtK >= bm25.recallAtK - 1e-9,
			`hybrid recall@${K} (${hybrid.recallAtK.toFixed(3)}) must not regress vs BM25 (${bm25.recallAtK.toFixed(3)})`,
		);
		console.log(
			`  → hybrid recall@${K}=${(hybrid.recallAtK * 100).toFixed(0)}% vs BM25 ${(bm25.recallAtK * 100).toFixed(0)}% on the clean synthetic gold.\n` +
				"    The mix's real wins (trust down-weighting, multi-signal robustness, optional MMR diversity) show on\n" +
				"    messy REAL data — recall@k on a clean gold mainly proves it doesn't regress.",
		);
	});
});
