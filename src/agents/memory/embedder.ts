/**
 * Embeddings seam (Tideline v2, convex-hybrid lane). Convex stores + ANN-indexes
 * vectors (the `by_embedding` vectorIndex) but does NOT generate them — so the
 * embedding model is OURS to provide. This is the pluggable seam: the recall +
 * write paths depend on {@link Embedder}, not on a concrete model.
 *
 * The bundled default ({@link HrrEmbedder}) is a ZERO-DEPENDENCY, fully
 * OFFLINE, deterministic phase-atom HRR embedder — air-gap-clean by
 * construction (no API key, no model download). Its random phase atoms are
 * near-ORTHOGONAL, so unrelated text scores ~0 (a clean floor with far less
 * vector-lane flooding). {@link HashingEmbedder} is the simpler alternative:
 * signed feature hashing of the same token unigrams + char tri-grams into a
 * fixed-width L2-normalised vector. Both stay strictly bag-of-words: they
 * capture lexical + MORPHOLOGICAL overlap ("reside"/"residence"/"residing" land
 * near each other) — more than BM25's exact-term match — but neither has
 * learned synonymy ("car"≈"automobile"). For that, drop a small learned
 * transformer embedding model (via a local transformer runtime) or a hosted
 * embeddings API into this same seam and bump the vectorIndex `dimensions` to
 * match. The hybrid PLUMBING is model-agnostic — only the vector quality changes.
 */

import { createHash } from "node:crypto";

export interface Embedder {
	/** Stable id (model‖dims) for cache-invalidation + provenance. */
	readonly id: string;
	/** Vector dimensionality — MUST equal the convex `by_embedding` vectorIndex `dimensions`. */
	readonly dims: number;
	/** Embed a batch of texts → one unit vector each (same order). */
	embed(texts: string[]): number[][] | Promise<number[][]>;
}

/** djb2 hash → unsigned 32-bit; salted so the index hash and the sign hash differ. */
function hash32(s: string, salt: number): number {
	let h = 5381 ^ salt;
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
	return h >>> 0;
}

/** Lowercase alphanumeric token unigrams + char tri-grams (within tokens). The
 *  features the hashing embedder buckets — n-grams give the morphological signal
 *  BM25 lacks. */
function features(text: string): string[] {
	const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
	const out: string[] = [];
	for (const t of toks) {
		out.push(`w:${t}`); // unigram
		const padded = `^${t}$`;
		for (let i = 0; i + 3 <= padded.length; i++) out.push(`g:${padded.slice(i, i + 3)}`); // char tri-gram
	}
	return out;
}

/**
 * Zero-dep, offline, deterministic feature-hashing embedder (the simpler
 * alternative to the bundled-default {@link HrrEmbedder}). Signed feature
 * hashing (Weinberger et al.) into `dims` buckets, L2-normalised. Deterministic
 * ⇒ great for tests + cross-mode parity; the SAME text always embeds
 * identically in fs and convex mode.
 */
export class HashingEmbedder implements Embedder {
	readonly id: string;
	constructor(readonly dims: number = 256) {
		this.id = `hashing-v1:${dims}`;
	}

	embed(texts: string[]): number[][] {
		return texts.map((text) => this.embedOne(text));
	}

	private embedOne(text: string): number[] {
		const vec = new Array<number>(this.dims).fill(0);
		for (const f of features(text)) {
			const bucket = hash32(f, 1) % this.dims;
			const sign = (hash32(f, 2) & 1) === 0 ? 1 : -1; // sign hashing → unbiased collisions
			vec[bucket] = (vec[bucket] ?? 0) + sign;
		}
		// L2-normalise so cosine = dot, and short/long texts compare fairly.
		let norm = 0;
		for (const x of vec) norm += x * x;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < this.dims; i++) vec[i] = (vec[i] ?? 0) / norm;
		return vec;
	}
}

/** Cosine similarity of two equal-length unit (or non-unit) vectors, in [-1, 1]. */
export function cosine(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * HRR embedder — Holographic Reduced Representations: SHA-256-seeded phase atoms
 * bundled by superposition; no model, deterministic, offline. The upgrade over
 * {@link HashingEmbedder}: random phase atoms are near-ORTHOGONAL,
 * so unrelated text scores ~0 (vs the hash embedder's ~0.16 function-word floor)
 * → far less vector-lane flooding + cleaner separation.
 *
 * Cosine-compatible with Convex's `by_embedding` vectorIndex: each phase `p` is
 * stored as the pair `[cos p, sin p]`, so the dot product of two such vectors is
 * `Σ cos(a_i − b_i)` = the HRR phase similarity. The emitted vectors are
 * L2-normalised, so that dot is a positive scaling of the raw phase sum that
 * preserves cosine ordering. `phases` atoms → `2·phases`-dim unit vector
 * (default 128 → 256, matching the deployed index).
 *
 * Still bag-of-words (no learned synonymy — "car"≉"automobile"); that needs a
 * learned model (a local embedding model, or a hosted embeddings API), which
 * plugs into this same {@link Embedder} seam (async) when wanted.
 */
export class HrrEmbedder implements Embedder {
	readonly id: string;
	readonly dims: number;
	private readonly atomCache = new Map<string, Float64Array>();

	constructor(private readonly phases: number = 128) {
		this.dims = phases * 2;
		this.id = `hrr-v1:${this.dims}`;
	}

	embed(texts: string[]): number[][] {
		return texts.map((t) => this.embedOne(t));
	}

	/** SHA-256-seeded phase atom for a feature: hash `feat:i` rounds, each digest
	 *  → 16 uint16 → 16 phases in [0, 2π), until `phases` filled. Cached. */
	private atom(feat: string): Float64Array {
		const hit = this.atomCache.get(feat);
		if (hit) return hit;
		const out = new Float64Array(this.phases);
		let filled = 0;
		let round = 0;
		while (filled < this.phases) {
			const digest = createHash("sha256").update(`${feat}:${round}`).digest();
			for (let i = 0; i + 2 <= digest.length && filled < this.phases; i += 2) {
				const u16 = digest.readUInt16LE(i);
				out[filled++] = (u16 * (2 * Math.PI)) / 65536;
			}
			round++;
		}
		this.atomCache.set(feat, out);
		return out;
	}

	private embedOne(text: string): number[] {
		// Features = token unigrams + char tri-grams (the n-grams add a
		// morphological signal a token-only bundle would miss).
		const feats = features(text);
		if (feats.length === 0) feats.push("w:__hrr_empty__");
		// Bundle by superposition: per phase index, sum the unit complex numbers
		// exp(i·phase) across atoms, then take the angle = circular mean.
		const sumCos = new Float64Array(this.phases);
		const sumSin = new Float64Array(this.phases);
		for (const f of feats) {
			const a = this.atom(f);
			for (let i = 0; i < this.phases; i++) {
				sumCos[i] = (sumCos[i] ?? 0) + Math.cos(a[i] ?? 0);
				sumSin[i] = (sumSin[i] ?? 0) + Math.sin(a[i] ?? 0);
			}
		}
		// Emit the cosine-compatible [cos p, sin p] vector, L2-normalised.
		const vec = new Array<number>(this.dims);
		for (let i = 0; i < this.phases; i++) {
			const phase = Math.atan2(sumSin[i] ?? 0, sumCos[i] ?? 0);
			vec[2 * i] = Math.cos(phase);
			vec[2 * i + 1] = Math.sin(phase);
		}
		let norm = 0;
		for (const x of vec) norm += x * x;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < this.dims; i++) vec[i] = (vec[i] ?? 0) / norm;
		return vec;
	}
}

/** The process default embedder. Swap via {@link setDefaultEmbedder} to plug a
 *  learned model in without touching the recall/write sites. */
let _default: Embedder = new HrrEmbedder(128);
export function getDefaultEmbedder(): Embedder {
	return _default;
}
export function setDefaultEmbedder(e: Embedder): void {
	_default = e;
}
