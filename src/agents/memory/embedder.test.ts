import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { cosine, HrrEmbedder } from "./embedder.js";

/**
 * Embeddings seam (Tideline v2). Covers the genuine correctness edges of the
 * bundled zero-dep embedder + the cosine helper: degenerate cosine inputs
 * (length-mismatch, zero-norm), the empty/whitespace sentinel path producing a
 * finite vector, and cross-instance determinism (cross-mode parity depends on
 * it). These are the parts where a silent NaN or non-determinism would corrupt
 * the vector lane without any loud failure.
 */

describe("cosine", () => {
	it("returns 0 when lengths mismatch", () => {
		assert.equal(cosine([1, 2, 3], [1, 2]), 0);
	});

	it("returns 0 for a zero-norm input (no NaN)", () => {
		assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
		assert.equal(cosine([1, 2, 3], [0, 0, 0]), 0);
		assert.equal(cosine([0, 0], [0, 0]), 0);
	});

	it("returns 0 for empty vectors", () => {
		assert.equal(cosine([], []), 0);
	});

	it("equals the dot product for unit vectors", () => {
		// Orthonormal pair → dot 0; identical unit vector → dot 1.
		const a = [1, 0, 0];
		const b = [0, 1, 0];
		assert.equal(cosine(a, b), 0);
		assert.equal(cosine(a, a), 1);
		// A general unit vector: cosine equals the raw dot product.
		const u = [0.6, 0.8];
		const v = [0.8, 0.6];
		const dot = u[0]! * v[0]! + u[1]! * v[1]!;
		assert.ok(Math.abs(cosine(u, v) - dot) < 1e-12);
	});
});

describe("HrrEmbedder", () => {
	it("embeds empty and whitespace-only text to a finite 256-dim vector via the sentinel", () => {
		const e = new HrrEmbedder(); // default 128 phases → 256 dims
		assert.equal(e.dims, 256);
		for (const text of ["", "   ", "\t\n  "]) {
			const vec = e.embed([text])[0];
			assert.ok(vec, "embed returned a vector");
			assert.equal(vec.length, 256);
			for (const x of vec) assert.ok(Number.isFinite(x), `non-finite component for ${JSON.stringify(text)}`);
		}
		// The empty sentinel must be a unit vector (L2-normalised), not all-zero.
		const empty = e.embed([""])[0];
		assert.ok(empty);
		const norm = Math.sqrt(empty.reduce((s, x) => s + x * x, 0));
		assert.ok(Math.abs(norm - 1) < 1e-9);
		// SENTINEL SENSITIVITY: this assertion FAILS if the `__hrr_empty__` sentinel
		// push is removed. Without it, feats=[] ⇒ every phase = atan2(0,0) = 0 ⇒
		// vec[2i+1] = sin(0) = 0 for ALL i (a degenerate [1,0,1,0,…] vector that is
		// STILL a unit vector — so the norm check above can't catch the regression).
		// The sentinel hashes to real phases, so some sin (odd-index) component is ≠0.
		const sinComponents = empty.filter((_, i) => i % 2 === 1);
		assert.ok(
			sinComponents.some((x) => Math.abs(x) > 1e-9),
			"the empty sentinel yields real phases (non-degenerate) — a sin component is non-zero",
		);
	});

	it("is deterministic across instances", () => {
		const a = new HrrEmbedder(128);
		const b = new HrrEmbedder(128);
		const texts = ["hello world", "the cat sat", "", "Résumé reside residing"];
		const va = a.embed(texts);
		const vb = b.embed(texts);
		assert.deepEqual(va, vb);
	});
});
