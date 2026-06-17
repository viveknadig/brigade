/**
 * Tideline — Brigade's long-term memory framework. Public FACADE + adapter SPI
 * (build Step 5: freeze the surface).
 *
 * This is the single, stable entry the rest of Brigade (and any future OSS
 * adopter) imports. The internal pieces — `FactStore` (storage + cross-mode
 * dispatch), `scoring` (the shared BM25 scorer), `write-gate` (the poisoning
 * guard), `links` (the graph substrate) — sit behind it. The facade adds no
 * recall logic of its own: it delegates to one {@link StorageAdapter} so the
 * write-gate, the shared scorer, and the fs ↔ convex dispatch all apply
 * uniformly and exactly once.
 *
 * SPI = four adapters the facade composes:
 *   - {@link StorageAdapter}  — the persistence backend (v1: `FactStore`, which
 *     itself dispatches fs ↔ convex). The one adapter that's fully live in v1.
 *   - {@link ClockAdapter}    — injectable time (default = system clock). RESERVED:
 *     the facade does not yet route reads/writes through it in v1.
 *   - {@link EmbedderAdapter} — a RESERVED learned-embedder seam. Recall in v1 is
 *     always served by the bundled zero-dep HRR vector lane inside `FactStore`;
 *     passing an embedder to the facade records the wiring but does NOT change
 *     recall (the facade never calls it in v1). A future version routes the lane
 *     through it to upgrade to true synonymy. Optional.
 *   - {@link LlmAdapter}      — LLM for reflection/synthesis. Optional seam,
 *     used by Phase-3 dream/consolidation; unused in v1.
 *
 * "Extraction would be a publish": nothing here imports Brigade-specific
 * modules — only the sibling memory primitives — so Tideline can be lifted into
 * a standalone package by re-exporting this file + its deps.
 */

import { FactStore } from "./records.js";
import type { ListFilter, MemoryLifecycle, MemoryRecord, NewFact, RecordOriginFilter } from "./records.js";
import type { ScoreBreakdown } from "./scoring.js";
import { backlinksTo, linksFrom } from "./links.js";
import type { MemoryLink, MemoryLinkKind } from "./links.js";

/** A recalled fact with its relevance score (the ranked recall result). */
export type RecalledFact = MemoryRecord & { score: number };
/** A recalled fact plus the {@link ScoreBreakdown} explaining its rank. */
export type ExplainedFact = MemoryRecord & { score: number; breakdown: ScoreBreakdown };

export type RecallOpts = { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter };
export type ExplainOpts = { limit?: number; origin?: RecordOriginFilter };
export type ContextOpts = ExplainOpts & { maxChars?: number };
/** Feedback signal on a recalled fact (the continual-learning loop). Asymmetric:
 *  `up` nudges importance/confidence +0.05 and reinforces decay; `down` nudges
 *  −0.10 (a few bad recalls outweigh many lukewarm ones). Both persist + log. */
export type FeedbackSignal = "up" | "down";

// ───────────────────────── SPI: the adapters ─────────────────────────

/** Injectable time source. Default = the system clock. */
export interface ClockAdapter {
	now(): number;
}

/** The persistence backend. `FactStore` is the v1 realization (it dispatches
 *  fs ↔ convex internally); an alternative backend or an OSS adopter targets
 *  this. Invariants every adapter MUST uphold (the bundled FactStore does):
 *   - `write` applies the write-gate + dedup; a blocked write throws and
 *     persists nothing.
 *   - `search`/`explainRecall` enforce origin isolation BEFORE scoring and use
 *     the shared scorer; `explainRecall` never reinforces decay. */
export interface StorageAdapter {
	write(fact: NewFact): MemoryRecord;
	search(query: string, opts?: RecallOpts): RecalledFact[];
	/** Optional HYBRID recall (BM25 ⊕ vector). When present, `recall`/`context`
	 *  prefer it over pure-lexical `search` (the bundled FactStore implements it in
	 *  both fs + convex mode); a backend that omits it transparently falls back to
	 *  `search`. */
	searchHybrid?(query: string, opts?: RecallOpts): RecalledFact[];
	explainRecall(query: string, opts?: ExplainOpts): ExplainedFact[];
	list(filter?: ListFilter): MemoryRecord[];
	readAll(): MemoryRecord[];
	markAccessed(ids: string[]): void;
	setLifecycle(ids: string[], lifecycle: MemoryLifecycle): void;
	applyFeedback(memoryId: string, signal: "up" | "down"): MemoryRecord | undefined;
}

/** Learned-embedder seam. **RESERVED — unused by the facade in v1**: recall is
 *  served by the bundled zero-dep HRR vector lane inside `FactStore`, not by an
 *  embedder passed here. A future version plugs a learned model in to upgrade
 *  that lane to true synonymy. Defined now so the column/contract isn't designed
 *  twice. */
export interface EmbedderAdapter {
	readonly dims: number;
	embed(texts: string[]): Promise<number[][]>;
}

/** LLM seam for reflection/synthesis (Phase-3 dream/consolidation). Optional;
 *  unused in v1. */
export interface LlmAdapter {
	complete(prompt: string): Promise<string>;
}

/** A fact with its graph neighbourhood — the `inspect` result. */
export interface FactInspection {
	record: MemoryRecord;
	links: MemoryLink[];
	backlinks: Array<{ from: string; kind: MemoryLinkKind }>;
}

const SYSTEM_CLOCK: ClockAdapter = { now: () => Date.now() };

// ───────────────────────────── the facade ────────────────────────────

/**
 * The Tideline facade — the public entry point. Verbs:
 * `add · search · explain · context · feedback · purge · inspect · export`
 * (plus `remember`/`recall`/`list` aliases for existing call sites). Origin is
 * first-class on every read/write that touches recall.
 */
export class Tideline {
	private constructor(
		private readonly store: StorageAdapter,
		private readonly clock: ClockAdapter,
		private readonly embedder?: EmbedderAdapter,
		private readonly llm?: LlmAdapter,
	) {}

	/** Open Tideline for a workspace directory (the common case). The optional
	 *  adapters default to: system clock, no embedder (v1 = FTS5-only), no LLM. */
	static open(
		workspaceDir: string,
		adapters: { clock?: ClockAdapter; embedder?: EmbedderAdapter; llm?: LlmAdapter } = {},
	): Tideline {
		return new Tideline(new FactStore(workspaceDir), adapters.clock ?? SYSTEM_CLOCK, adapters.embedder, adapters.llm);
	}

	/** Wrap an existing {@link StorageAdapter} (DI / shared store / a swapped backend). */
	static over(
		store: StorageAdapter,
		adapters: { clock?: ClockAdapter; embedder?: EmbedderAdapter; llm?: LlmAdapter } = {},
	): Tideline {
		return new Tideline(store, adapters.clock ?? SYSTEM_CLOCK, adapters.embedder, adapters.llm);
	}

	/** Whether a learned embedder is WIRED into the facade — reflects wiring only,
	 *  not recall behavior. In v1 recall is always served by the bundled HRR vector
	 *  lane regardless of this flag; a wired embedder is recorded but unused. */
	get hasVectors(): boolean {
		return this.embedder !== undefined;
	}

	// ── add ──
	/** Persist a fact (write-gate + dedup applied). Throws `WriteGateError` on a
	 *  blocked poisoning write. */
	add(fact: NewFact): MemoryRecord {
		return this.store.write(fact);
	}
	remember(fact: NewFact): MemoryRecord {
		return this.add(fact);
	}

	// ── search ──
	/** Ranked recall over active, origin-matching facts (reinforces decay unless
	 *  `markAccessed: false`). */
	search(query: string, opts: RecallOpts = {}): RecalledFact[] {
		return this.store.search(query, opts);
	}
	/** The recall entry point callers should prefer — HYBRID (BM25 ⊕ vector) when
	 *  the backend offers it, else pure-lexical `search`. `search` stays a
	 *  lexical-only primitive (the eval floor / transparency). */
	recall(query: string, opts: RecallOpts = {}): RecalledFact[] {
		return this.store.searchHybrid ? this.store.searchHybrid(query, opts) : this.store.search(query, opts);
	}

	/** Passive recall transparency — same ranking as `search`, each hit with its
	 *  score breakdown, and NO decay reinforcement. */
	explain(query: string, opts: ExplainOpts = {}): ExplainedFact[] {
		return this.store.explainRecall(query, opts);
	}

	// ── context ──
	/** A budgeted, origin-scoped recall block ready to drop into a prompt — the
	 *  facts joined into a capped string (relevance-ranked (decay-weighted),
	 *  highest first, truncated to `maxChars`, default 1200). Passive (no decay
	 *  reinforcement). `<`/`>` in fact text are defanged so a fact can't inject
	 *  markup. Returns `undefined` when nothing relevant is stored. */
	context(query: string, opts: ContextOpts = {}): string | undefined {
		const { maxChars = 1200, ...recallOpts } = opts;
		const recallOptsPassive = { ...recallOpts, markAccessed: false };
		const hits = this.store.searchHybrid
			? this.store.searchHybrid(query, recallOptsPassive)
			: this.store.search(query, recallOptsPassive);
		if (hits.length === 0) return undefined;
		const lines: string[] = [];
		let used = 0;
		for (const h of hits) {
			const safe = h.content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
			const line = `- [${h.segment}] ${safe}`;
			// `+ 1` per line accounts for the "\n" separator. This is a conservative
			// upper bound: the final line carries no trailing separator, so the
			// budget over-counts by one — the emitted block is never longer than the
			// accounting assumes (the block.length <= maxChars guarantee holds).
			if (used + line.length + 1 > maxChars && lines.length > 0) break;
			lines.push(line);
			used += line.length + 1;
		}
		return lines.join("\n");
	}

	// ── feedback ──
	/** Record relevance feedback on a recalled fact. Asymmetric importance/
	 *  confidence update (`up` +0.05 / `down` −0.10), persisted + logged. Recall's
	 *  trust/importance modulation then adapts, closing the loop: recall →
	 *  feedback → better recall. */
	feedback(memoryId: string, signal: FeedbackSignal): void {
		// The continual-learning loop's signal: asymmetric importance/confidence
		// update (+0.05 / −0.10), persisted + logged. Recall's trust/importance
		// modulation then adapts → recall improves from use.
		this.store.applyFeedback(memoryId, signal);
	}

	// ── purge ──
	/** Retract facts — v1 soft purge: lifecycle → `pruned` (excluded from recall).
	 *  Phase-3 `purge` (step 24) adds crypto-shred + cascade along `sourcePointers`. */
	purge(memoryIds: string[]): void {
		this.store.setLifecycle(memoryIds, "pruned");
	}

	// ── inspect ──
	/** Fact-level diagnostic: a single record with its outbound {@link MemoryLink}
	 *  edges and inbound backlinks (the graph neighbourhood). `undefined` if the
	 *  id isn't found. */
	inspect(memoryId: string): FactInspection | undefined {
		const all = this.store.readAll();
		const record = all.find((r) => r.memoryId === memoryId);
		if (!record) return undefined;
		return { record, links: linksFrom(record), backlinks: backlinksTo(all, memoryId) };
	}

	// ── export ──
	/** Full store dump (all lifecycles) for backup/portability. */
	export(): MemoryRecord[] {
		return this.store.readAll();
	}

	/** List active (or `filter.lifecycle`) facts, most-recent-first. */
	list(filter: ListFilter = {}): MemoryRecord[] {
		return this.store.list(filter);
	}
}
