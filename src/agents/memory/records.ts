/**
 * Structured memory records — the Brigade mirror of Boop's memory model
 * (`server/memory/types.ts`), adapted from Convex tables to an append-only
 * JSONL file (`<workspace>/memory/facts.jsonl`). Single-user, so reads scan
 * the whole file and writes are read-modify-write — no concurrency budget to
 * fight, unlike Convex's 500/150-row scan caps.
 *
 * A "memory" here is a structured fact, NOT a raw note: one declarative
 * sentence tagged with a `segment` (what kind of fact) and a `tier` +
 * `importance` + `decayRate` derived from that segment. This is what the
 * post-turn extraction subagent emits and what `write_memory` persists; the
 * lexical recall layer (storage.ts) searches these alongside MEMORY.md +
 * daily notes.
 *
 * Conflict resolution mirrors Boop: `supersedes` archives older records, the
 * `correction` segment overturns a prior belief, and a decay GC ages out
 * neglected facts. (Boop's 3-LLM consolidation debate is intentionally NOT
 * ported in v1 — supersede + decay cover the common cases.)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What kind of fact this is — drives tier/importance/decay defaults. */
export type MemorySegment =
	| "identity"
	| "preference"
	| "correction"
	| "relationship"
	| "project"
	| "knowledge"
	| "context";

/** How durable a record is. `permanent` is never decayed out. */
export type MemoryTier = "short" | "long" | "permanent";

/** Active = live, archived = superseded/decayed-but-kept, pruned = dead. */
export type MemoryLifecycle = "active" | "archived" | "pruned";

export interface MemoryRecord {
	memoryId: string;
	/** One clear declarative sentence. */
	content: string;
	segment: MemorySegment;
	tier: MemoryTier;
	/** 0..1 — segment default unless the writer overrides. */
	importance: number;
	/** Per-segment decay multiplier (higher = forgets faster). */
	decayRate: number;
	/** Bumped each time recall surfaces this record (decay reinforcement). */
	accessCount: number;
	/** Epoch ms of the last recall hit (or creation). */
	lastAccessedAt: number;
	/** Epoch ms when first written. */
	createdAt: number;
	/** Run/turn id that produced this fact, when known. */
	sourceTurn?: string;
	/** memoryIds this record archives (corrections/updates). */
	supersedes?: string[];
	lifecycle: MemoryLifecycle;
	/** Optional JSON sidecar, e.g. {"corrects":"the prior belief"}. */
	metadata?: Record<string, unknown>;
}

/**
 * Per-segment defaults — ported from Boop's `SEGMENT_DEFAULTS`
 * (`server/memory/types.ts:37-45`). `identity` is the most durable (permanent,
 * slow decay); `context` the most ephemeral (short tier, fast decay).
 */
export const SEGMENT_DEFAULTS: Record<
	MemorySegment,
	{ tier: MemoryTier; importance: number; decayRate: number }
> = {
	identity: { tier: "permanent", importance: 0.85, decayRate: 0.01 },
	correction: { tier: "long", importance: 0.8, decayRate: 0.015 },
	relationship: { tier: "long", importance: 0.75, decayRate: 0.02 },
	preference: { tier: "long", importance: 0.7, decayRate: 0.02 },
	project: { tier: "long", importance: 0.65, decayRate: 0.025 },
	knowledge: { tier: "long", importance: 0.6, decayRate: 0.03 },
	context: { tier: "short", importance: 0.4, decayRate: 0.08 },
};

export const MEMORY_SEGMENTS = Object.keys(SEGMENT_DEFAULTS) as MemorySegment[];

/** Relative path of the structured fact store within a workspace. */
export const FACTS_RELATIVE_PATH = path.join("memory", "facts.jsonl");

/**
 * Hard cap on a single fact's content. A fact is meant to be one sentence;
 * this stops a misbehaving model (or pasted blob) from writing a megabyte
 * "fact" that then bloats the always-read JSONL AND every auto-recall
 * injection. Generous enough for any legitimate fact.
 */
export const MAX_FACT_CONTENT_CHARS = 1000;

/** `mem_<base36 time>_<rand>` — Boop's id shape, time-sortable. */
export function makeMemoryId(): string {
	return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Clamp to [0,1], falling back to `fallback` when not a finite number. */
export function clampImportance(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

export interface NewFact {
	content: string;
	segment: MemorySegment;
	importance?: number;
	tier?: MemoryTier;
	sourceTurn?: string;
	supersedes?: string[];
	metadata?: Record<string, unknown>;
}

export interface ListFilter {
	segment?: MemorySegment;
	lifecycle?: MemoryLifecycle;
	/** Cap the number returned (most-recent-first). */
	limit?: number;
}

/**
 * Append-only-ish JSONL fact store. "Mutations" (markAccessed / supersede /
 * setLifecycle / decay) are read-modify-write of the whole file — fine at
 * single-user scale, and atomic via tmp+rename so a crash never leaves a
 * half-written store.
 */
export class FactStore {
	private readonly file: string;

	constructor(workspaceDir: string) {
		this.file = path.join(workspaceDir, FACTS_RELATIVE_PATH);
	}

	/** Absolute path to the JSONL file (for diagnostics). */
	get filePath(): string {
		return this.file;
	}

	/** Read every record. Malformed lines are skipped (never throws on a bad line). */
	readAll(): MemoryRecord[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: MemoryRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const rec = JSON.parse(trimmed) as MemoryRecord;
				if (rec && typeof rec.memoryId === "string" && typeof rec.content === "string") {
					out.push(rec);
				}
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		return out;
	}

	/** Active records, optionally filtered, most-recent-first, capped by `limit`. */
	list(filter: ListFilter = {}): MemoryRecord[] {
		const lifecycle = filter.lifecycle ?? "active";
		let recs = this.readAll().filter((r) => r.lifecycle === lifecycle);
		if (filter.segment) recs = recs.filter((r) => r.segment === filter.segment);
		recs.sort((a, b) => b.createdAt - a.createdAt);
		return filter.limit && filter.limit > 0 ? recs.slice(0, filter.limit) : recs;
	}

	/**
	 * Persist a new fact. Derives tier/importance/decay from the segment
	 * defaults (writer may override tier/importance). Archives any `supersedes`
	 * targets. Returns the stored record.
	 */
	write(fact: NewFact): MemoryRecord {
		const defaults = SEGMENT_DEFAULTS[fact.segment] ?? SEGMENT_DEFAULTS.context;
		const now = Date.now();
		const record: MemoryRecord = {
			memoryId: makeMemoryId(),
			content: fact.content.trim().slice(0, MAX_FACT_CONTENT_CHARS),
			segment: fact.segment,
			tier: fact.tier ?? defaults.tier,
			importance: clampImportance(fact.importance, defaults.importance),
			decayRate: defaults.decayRate,
			accessCount: 0,
			lastAccessedAt: now,
			createdAt: now,
			sourceTurn: fact.sourceTurn,
			supersedes: fact.supersedes && fact.supersedes.length > 0 ? fact.supersedes : undefined,
			lifecycle: "active",
			metadata: fact.metadata,
		};

		const all = this.readAll();
		// Archive superseded records (corrections/updates overwrite prior beliefs).
		if (record.supersedes) {
			const dead = new Set(record.supersedes);
			for (const r of all) {
				if (dead.has(r.memoryId) && r.lifecycle === "active") r.lifecycle = "archived";
			}
		}
		all.push(record);
		this.writeAll(all);
		return record;
	}

	/**
	 * Lexical search over active facts. Scores by how many query tokens appear
	 * in the content (substring), tie-broken by importance then recency —
	 * Boop's substring-fallback ranking. Marks every returned record accessed
	 * (recall reinforcement) unless `markAccessed: false`. Returns at most
	 * `limit` hits (default 8), each with its score.
	 */
	search(query: string, opts: { limit?: number; markAccessed?: boolean } = {}): Array<MemoryRecord & { score: number }> {
		const tokens = query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 1);
		if (tokens.length === 0) return [];
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const scored: Array<MemoryRecord & { score: number }> = [];
		for (const r of this.readAll()) {
			if (r.lifecycle !== "active") continue;
			const hay = r.content.toLowerCase();
			const matched = tokens.filter((t) => hay.includes(t)).length;
			if (matched === 0) continue;
			scored.push({ ...r, score: matched / tokens.length });
		}
		scored.sort(
			(a, b) => b.score - a.score || b.importance - a.importance || b.createdAt - a.createdAt,
		);
		const top = scored.slice(0, limit);
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/** Bump accessCount + lastAccessedAt for the given ids (recall reinforcement). */
	markAccessed(ids: string[]): void {
		if (ids.length === 0) return;
		const set = new Set(ids);
		const all = this.readAll();
		let changed = false;
		const now = Date.now();
		for (const r of all) {
			if (set.has(r.memoryId)) {
				r.accessCount += 1;
				r.lastAccessedAt = now;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/** Set the lifecycle of specific records (used by decay GC). */
	setLifecycle(ids: string[], lifecycle: MemoryLifecycle): void {
		if (ids.length === 0) return;
		const set = new Set(ids);
		const all = this.readAll();
		let changed = false;
		for (const r of all) {
			if (set.has(r.memoryId) && r.lifecycle !== lifecycle) {
				r.lifecycle = lifecycle;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/** Atomic whole-file rewrite (tmp + rename) so a crash can't corrupt the store. */
	private writeAll(records: MemoryRecord[]): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
		const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, this.file);
	}
}
