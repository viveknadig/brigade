/**
 * Structured memory records — an append-only JSONL file
 * (`<workspace>/memory/facts.jsonl`). Single-user, so reads scan the whole
 * file and writes are read-modify-write — no concurrency budget to fight.
 *
 * A "memory" here is a structured fact, NOT a raw note: one declarative
 * sentence tagged with a `segment` (what kind of fact) and a `tier` +
 * `importance` + `decayRate` derived from that segment. This is what the
 * post-turn extraction subagent emits and what `write_memory` persists; the
 * lexical recall layer (storage.ts) searches these alongside MEMORY.md +
 * daily notes.
 *
 * Conflict resolution: `supersedes` archives older records, the
 * `correction` segment overturns a prior belief, and a decay GC ages out
 * neglected facts. (A heavier 3-LLM consolidation debate is intentionally
 * NOT done in v1 — supersede + decay cover the common cases.)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	getCachedFacts,
	primeFactsCache,
	workspaceIdFromDir,
	writeThroughFactsCache,
} from "../../storage/facts-cache.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { bm25Score, type ScoreBreakdown } from "./scoring.js";
import { evaluateWriteGate, isTrustedTarget, isUntrustedSource, WriteGateError } from "./write-gate.js";
import type { MemoryLink } from "./links.js";
import { MemoryEventLog, type MemoryEvent } from "./event-log.js";
import { getDefaultEmbedder } from "./embedder.js";
import { recallHybrid } from "./hybrid.js";

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

/**
 * Where a fact CAME FROM — distinct from `createdBy` (the principal/origin).
 * Drives the write-gate (Step 12): low-trust sources (`tool_output`,
 * `retrieved_document`, `compaction`) can't supersede owner-authored facts or
 * write procedural records. `undefined` ⇔ legacy / owner-authored (trusted).
 */
export type MemorySourceType =
	| "user_instruction"
	| "owner_message"
	| "channel_message"
	| "tool_output"
	| "retrieved_document"
	| "compaction"
	| "extraction"
	| "dream";

/**
 * Epistemic state of a fact — distinct from {@link MemoryLifecycle} (which is
 * STORAGE state: active/archived/pruned). Dormant in v1 (the field persists but
 * nothing sets/reads it); Phase-2 cognition (trust, contradiction) drives it.
 */
export type MemoryStatus = "asserted" | "provisional" | "confirmed" | "disputed" | "retracted";

/** Modality of a fact's underlying content (Step 17 cold-pointer). The stored
 *  `content` is ALWAYS text (a transcript/caption) so recall is uniform; the
 *  media itself lives at `mediaPointer`. `undefined` ⇒ text. */
export type MemoryModality = "text" | "audio" | "image" | "video" | "document";

/**
 * Who wrote this memory record — used by the recall path to keep peer
 * memories isolated from the operator's view (and isolated per-session
 * from each other). Mirrors the `CronJobOrigin` shape from the cron tool
 * so the audit trail vocabulary stays consistent across primitives.
 *
 *   - `{ kind: "owner" }` — workspace owner (TUI / `connect` / CLI).
 *     Recallable by the owner across every owner session. NOT recalled
 *     by channel peers so the operator's private notes can't leak into
 *     an approved peer's chat.
 *   - `{ kind: "channel", channelId, conversationId, sessionKey }` —
 *     written from an approved channel peer's chat. Recallable ONLY
 *     when the calling turn matches all three (channel + conversation
 *     + session). Different chats from the same peer don't see each
 *     other; the operator never sees them in auto-recall.
 *
 * `accountId` is captured opportunistically for multi-account channels.
 *
 * Records persisted before this field existed have `createdBy: undefined`
 * — the recall path treats them as owner-origin for back-compat.
 */
export type MemoryRecordOrigin =
	| { kind: "owner" }
	| {
			kind: "channel";
			channelId: string;
			conversationId: string;
			sessionKey: string;
			accountId?: string;
	  };

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
	/**
	 * Origin of this record (see {@link MemoryRecordOrigin}). `undefined`
	 * ⇔ legacy record persisted before ownership tracking shipped —
	 * treated as `{ kind: "owner" }` by the recall path so existing
	 * facts keep their previous owner-visible behaviour.
	 */
	createdBy?: MemoryRecordOrigin;
	/** Where this fact came from (see {@link MemorySourceType}) — drives the
	 *  write-gate. `undefined` ⇔ legacy / owner-authored (trusted). */
	sourceType?: MemorySourceType;
	/** Typed edges to other facts (the graph substrate, Step 7). `supersedes[]`
	 *  is mirrored in at READ time by `linksFrom` — not stored here. */
	links?: MemoryLink[];
	/** Bi-temporal VALID-time interval (Step 7 cognition) — when the fact is true
	 *  in the world, distinct from `createdAt` (transaction time it was recorded).
	 *  Phase-2 contradiction handling closes `validTo` on a bi-temporal supersede.
	 *  Dormant in v1. */
	validFrom?: number;
	validTo?: number;
	/** Confidence in the fact, [0, 1]. Phase-2 trust folds this into ranking. Dormant in v1. */
	confidence?: number;
	/** Epistemic state (distinct from `lifecycle`, the storage state). Dormant in v1. */
	status?: MemoryStatus;
	/** Ids of the source material this fact was derived from (message ids, doc
	 *  ids, parent memoryIds). Phase-3 `purge` cascades along these. Dormant in v1. */
	sourcePointers?: string[];
	/** Dense vector for the HYBRID recall lane — populated on write in BOTH modes
	 *  (convex ANN-indexes it via `by_embedding`; fs cosine-scans it in-app). */
	embedding?: number[];
	/** Modality of the underlying content (Step 17 cold-pointer). `undefined` ⇒ text. */
	modality?: MemoryModality;
	/** Path/URI to the source media this fact was distilled from — the "cold
	 *  pointer" that keeps media OUT of the hot text index. */
	mediaPointer?: string;
	/** Optional JSON sidecar, e.g. {"corrects":"the prior belief"}. */
	metadata?: Record<string, unknown>;
	/** Single-valued ATTRIBUTE SLOT this fact sets (normalized snake_case, e.g.
	 *  `deploy_day`, `home_city`, `ui_theme`). When present, writing a NEW fact with
	 *  the SAME subjectKey + SAME origin auto-supersedes this one (the prior value is
	 *  archived, bi-temporally closed, and `contradicts`-linked) — so a correction
	 *  replaces the stale belief instead of piling up beside it. Omit for ADDITIVE
	 *  facts (pets, skills) that should coexist. Segment-independent by design. */
	subjectKey?: string;
}

/**
 * Per-segment defaults. `identity` is the most durable (permanent, slow
 * decay); `context` the most ephemeral (short tier, fast decay).
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

/**
 * Jaccard-similarity threshold above which two facts are treated as the same
 * at write time (dedup). Deliberately HIGH (0.85) so only near-identical
 * restatements collapse — distinct facts that merely share words (e.g. two
 * different facts about the same topic) are kept separate.
 */
export const DEDUP_SIMILARITY = 0.85;
/** Content-overlap floor for a `correction`-segment write to auto-supersede a
 *  same-origin same-SUBJECT prior fact (no slot/id needed). Lower than dedup
 *  (a correction changes the VALUE, so it won't be near-identical) but high
 *  enough that only same-subject facts match — "deploys on Thursdays" supersedes
 *  "deploys on Fridays" (≈0.6), never an unrelated fact. */
export const CORRECTION_SUPERSEDE_SIMILARITY = 0.5;

/** Lowercased alphanumeric token SET of a fact's content (for dedup). */
function tokenSet(content: string): Set<string> {
	return new Set(
		content
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 0),
	);
}

/** Normalize an attribute SLOT key: lowercase, non-alphanumeric runs → "_",
 *  trimmed of edge underscores. So "Deploy Day" / "deploy-day" / "deploy_day"
 *  all collapse to one slot, maximizing supersede matches across phrasings. */
function normalizeSubjectKey(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** Jaccard similarity |A∩B| / |A∪B| of two token sets (0 when both empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter += 1;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** `mem_<base36 time>_<rand>` — a time-sortable id shape. */
export function makeMemoryId(): string {
	return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Treat a missing origin as owner (back-compat with records persisted
 * before ownership tracking shipped). All recall + dedup logic should
 * route through this helper rather than reading `createdBy` directly so
 * the legacy default stays in one place.
 */
export function resolveRecordOrigin(
	origin: MemoryRecordOrigin | undefined,
): MemoryRecordOrigin {
	return origin ?? { kind: "owner" };
}

/** Two origins are the same when both fields-by-fields match. */
export function sameOrigin(
	a: MemoryRecordOrigin | undefined,
	b: MemoryRecordOrigin | undefined,
): boolean {
	const resolvedA = resolveRecordOrigin(a);
	const resolvedB = resolveRecordOrigin(b);
	if (resolvedA.kind !== resolvedB.kind) return false;
	if (resolvedA.kind === "owner") return true;
	const channelA = resolvedA;
	const channelB = resolvedB as Extract<MemoryRecordOrigin, { kind: "channel" }>;
	return (
		channelA.channelId === channelB.channelId &&
		channelA.conversationId === channelB.conversationId &&
		channelA.sessionKey === channelB.sessionKey
	);
}

/**
 * Recall-side filter. Per the design:
 *   - An owner caller's filter is `{ kind: "owner" }` — they recall ONLY
 *     owner-written records (and legacy `undefined`-origin records, which
 *     resolve to owner). The operator's view stays clean of peer-written
 *     state.
 *   - A channel-peer caller's filter is `{ kind: "channel", … }` matching
 *     their channelId + conversationId + sessionKey. They recall ONLY
 *     records whose origin matches exactly. Different sessions from the
 *     same peer don't see each other; the operator's records are
 *     invisible to them too.
 *
 * `undefined` filter = no filtering (used by maintenance paths like
 * decay GC, consolidation, doctor diagnostics — anything that legitimately
 * needs the whole store).
 */
export type RecordOriginFilter = MemoryRecordOrigin | undefined;

/** True if the record matches the filter. `undefined` filter matches every record. */
export function recordMatchesOriginFilter(
	record: { createdBy?: MemoryRecordOrigin },
	filter: RecordOriginFilter,
): boolean {
	if (filter === undefined) return true;
	return sameOrigin(record.createdBy, filter);
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
	/**
	 * Stamped by the `write_memory` per-call gate (owner default; channel
	 * peer = their session origin). The store persists it verbatim onto
	 * the resulting record so the recall path can filter by it.
	 */
	createdBy?: MemoryRecordOrigin;
	/** Source type for the write-gate (owner_message, tool_output, …). Omit ⇒
	 *  owner-authored/trusted. */
	sourceType?: MemorySourceType;
	/** Typed edges to other facts (the graph substrate, Step 7). */
	links?: MemoryLink[];
	/** Cognition fields (Step 7) — bi-temporal valid interval, confidence,
	 *  epistemic status, and source pointers. All dormant in v1 (persisted for
	 *  Phase-2 use); omit them and the record behaves exactly as before. */
	validFrom?: number;
	validTo?: number;
	confidence?: number;
	status?: MemoryStatus;
	sourcePointers?: string[];
	/** Cold-pointer multimodal (Step 17): `content` = the transcript/caption text. */
	modality?: MemoryModality;
	mediaPointer?: string;
	/** Single-valued attribute slot (e.g. `deploy_day`) — a new value for the same
	 *  slot + origin auto-supersedes the prior one. Omit for additive facts. */
	subjectKey?: string;
}

export interface ListFilter {
	segment?: MemorySegment;
	lifecycle?: MemoryLifecycle;
	/** Cap the number returned (most-recent-first). */
	limit?: number;
	/**
	 * Restrict to records matching this origin. Omit to return EVERY
	 * record regardless of origin (the maintenance default — used by
	 * decay GC, consolidation, doctor diagnostics). Tool-facing callers
	 * (`read_memory` / `recall_memory` / auto-recall) MUST pass an
	 * explicit filter so peer + operator state stay isolated.
	 */
	origin?: RecordOriginFilter;
}

/**
 * Append-only-ish JSONL fact store. "Mutations" (markAccessed / supersede /
 * setLifecycle / decay) are read-modify-write of the whole file — fine at
 * single-user scale, and atomic via tmp+rename so a crash never leaves a
 * half-written store.
 */
export class FactStore {
	private readonly file: string;

	private eventLogCache?: MemoryEventLog;

	constructor(workspaceDir: string) {
		this.file = path.join(workspaceDir, FACTS_RELATIVE_PATH);
	}

	/** Absolute path to the JSONL file (for diagnostics). */
	get filePath(): string {
		return this.file;
	}

	/** The append-only event log (sibling `events.jsonl` of the facts file). */
	private eventLog(): MemoryEventLog {
		if (!this.eventLogCache) {
			this.eventLogCache = new MemoryEventLog(path.join(path.dirname(this.file), "events.jsonl"));
		}
		return this.eventLogCache;
	}

	/** Emit a provenance event. Filesystem mode only — convex mode defers the
	 *  log to the server side (v1), and the log is additive (never affects
	 *  recall), so the asymmetry is safe. Best-effort (the log swallows errors). */
	private emit(event: MemoryEvent): void {
		if (tryGetRuntimeContext()?.mode === "convex") return;
		this.eventLog().append(event);
	}

	/** The append-only provenance history (filesystem mode). Empty in convex
	 *  mode for v1. Ordered oldest-first. */
	readEvents(): MemoryEvent[] {
		if (tryGetRuntimeContext()?.mode === "convex") return [];
		return this.eventLog().readAll();
	}

	/** Read every record. Malformed lines are skipped (never throws on a bad line). */
	readAll(): MemoryRecord[] {
		// Convex mode — serve from the boot-hydrated per-workspace cache. An
		// unprimed workspace genuinely has no facts (boot hydrates every
		// config agent's workspace + main); prime the empty shape so later
		// writes diff against it.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
			const cached = getCachedFacts(wsId);
			if (cached) return structuredClone(cached);
			primeFactsCache(wsId, []);
			return [];
		}

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
		if (filter.origin !== undefined) {
			recs = recs.filter((r) => recordMatchesOriginFilter(r, filter.origin));
		}
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
			...(fact.createdBy !== undefined ? { createdBy: fact.createdBy } : {}),
			...(fact.sourceType !== undefined ? { sourceType: fact.sourceType } : {}),
			...(fact.links !== undefined && fact.links.length > 0 ? { links: fact.links } : {}),
			...(fact.validFrom !== undefined ? { validFrom: fact.validFrom } : {}),
			...(fact.validTo !== undefined ? { validTo: fact.validTo } : {}),
			...(fact.confidence !== undefined ? { confidence: fact.confidence } : {}),
			...(fact.status !== undefined ? { status: fact.status } : {}),
			...(fact.sourcePointers !== undefined && fact.sourcePointers.length > 0
				? { sourcePointers: fact.sourcePointers }
				: {}),
			...(fact.modality !== undefined ? { modality: fact.modality } : {}),
			...(fact.mediaPointer !== undefined ? { mediaPointer: fact.mediaPointer } : {}),
			...(fact.subjectKey && fact.subjectKey.trim() ? { subjectKey: normalizeSubjectKey(fact.subjectKey) } : {}),
			metadata: fact.metadata,
		};

		const all = this.readAll();

		// Write-gate (Tideline Step 12) — an UNTRUSTED source (tool_output /
		// retrieved_document) must not poison the authoritative store: it can't
		// author an identity/preference/correction fact, nor supersede an
		// owner-authored one. Dormant for trusted/legacy writes (sourceType
		// undefined). Evaluated BEFORE any mutation so a blocked write is a
		// clean no-op (throws WriteGateError; the caller surfaces it).
		if (isUntrustedSource(record.sourceType)) {
			const supersedeIds = new Set(record.supersedes ?? []);
			const verdict = evaluateWriteGate({
				sourceType: record.sourceType,
				segment: record.segment,
				supersedeTargets: all
					.filter((r) => supersedeIds.has(r.memoryId))
					.map((r) => ({ memoryId: r.memoryId, sourceType: r.sourceType })),
			});
			if (!verdict.allow) {
				this.emit({
					at: now,
					kind: "blocked",
					memoryId: record.memoryId,
					segment: record.segment,
					...(record.sourceType !== undefined ? { sourceType: record.sourceType } : {}),
					reason: verdict.reason,
				});
				throw new WriteGateError(verdict.reason);
			}
		}

		// SUPERSEDE the prior belief(s) this write replaces — WITHOUT relying on the
		// model recalling ids. Two triggers, both SAME-origin, soft-archive (bi-temporal
		// close + `contradicts` link), history kept:
		//   (a) an explicit attribute SLOT (subjectKey) → supersede same-slot values
		//       (precise; segment-independent — a `correction` supersedes a `preference`).
		//   (b) a `correction`-segment write with NO slot → supersede same-SUBJECT active
		//       facts (content overlap ≥ CORRECTION_SUPERSEDE_SIMILARITY). The correction
		//       SEGMENT is the model's replace-intent signal (it reliably uses it); the
		//       overlap gate keeps it to the same subject. ADDITIVE facts (pets, skills)
		//       are written under other segments, so they are never corrections and never
		//       auto-superseded here — that's the single-valued-vs-additive safety line.
		// A near-identical prior (restated, not changed) is reinforced, not churned.
		// An UNTRUSTED source can't archive a TRUSTED prior (the write-gate override guard).
		const slotSuperseded: string[] = [];
		const supersedeByContent = !record.subjectKey && record.segment === "correction";
		if ((record.subjectKey || supersedeByContent) && !record.supersedes) {
			const incoming = tokenSet(record.content);
			const priors = all.filter(
				(r) =>
					r.lifecycle === "active" &&
					r.memoryId !== record.memoryId &&
					sameOrigin(r.createdBy, record.createdBy) &&
					(record.subjectKey
						? r.subjectKey === record.subjectKey
						: jaccard(incoming, tokenSet(r.content)) >= CORRECTION_SUPERSEDE_SIMILARITY),
			);
			// Same write-gate guard as the archive loop + dedup below: an
			// UNTRUSTED source must not reinforce (bump importance / refresh
			// access on) a TRUSTED, owner-authored prior through this restate
			// back door — that's an unsuperseded mutation the write-gate never
			// sees. When incoming is untrusted and the match is trusted, it
			// falls through to a separate record, leaving the owner fact as-is.
			const restated = priors.find(
				(r) =>
					jaccard(incoming, tokenSet(r.content)) >= DEDUP_SIMILARITY &&
					!(isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)),
			);
			if (restated) {
				restated.importance = Math.max(restated.importance, record.importance);
				restated.lastAccessedAt = now;
				restated.accessCount += 1;
				if (!restated.sourceTurn && record.sourceTurn) restated.sourceTurn = record.sourceTurn;
				this.writeAll(all);
				this.emit({ at: now, kind: "reinforced", memoryId: restated.memoryId, segment: restated.segment });
				return restated;
			}
			for (const r of priors) {
				if (isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)) continue;
				r.lifecycle = "archived";
				r.validTo = now;
				slotSuperseded.push(r.memoryId);
			}
			if (slotSuperseded.length > 0) {
				record.links = [
					...(record.links ?? []),
					...slotSuperseded.map((target) => ({ kind: "contradicts" as const, target })),
				];
			}
		}

		// Write-time dedup (no LLM). A near-identical ACTIVE fact already exists
		// (e.g. the model called write_memory AND the post-turn extraction sweep
		// distilled the same fact) → don't add a parallel copy. Instead reinforce
		// the existing one: keep the higher importance, refresh access, inherit a
		// sourceTurn if it lacked one. Skipped for explicit corrections/updates
		// (they carry `supersedes` and intentionally replace prior beliefs). This
		// is the cheap layer; semantic contradictions are handled by consolidation.
		//
		// Origin guard: dedup ONLY merges with records of the same origin. A
		// peer's "I prefer dark mode" must not merge into an owner's identical
		// note (which would lift the peer's fact to owner-visible) or into
		// another peer's identical note (which would cross-pollinate
		// session-scoped state). Different-origin facts stay separate even if
		// the text matches.
		if (!record.supersedes && !record.subjectKey && !supersedeByContent) {
			const incoming = tokenSet(record.content);
			const dup = all.find(
				(r) =>
					r.lifecycle === "active" &&
					sameOrigin(r.createdBy, record.createdBy) &&
					jaccard(incoming, tokenSet(r.content)) >= DEDUP_SIMILARITY &&
					// Write-gate blind-spot guard: dedup-merge reinforces the matched
					// fact (bumps importance + refreshes access). An UNTRUSTED source
					// (tool_output / retrieved_document / compaction) must not be able to
					// reinforce a TRUSTED, owner-authored fact through this back door —
					// that is an unsuperseded mutation the write-gate never sees. When the
					// incoming write is untrusted and the match is owner-authored/trusted,
					// skip the merge: the untrusted write falls through to a separate
					// record (subject to the gate's segment rule), leaving the owner fact
					// exactly as the operator left it.
					!(isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)),
			);
			if (dup) {
				dup.importance = Math.max(dup.importance, record.importance);
				dup.lastAccessedAt = now;
				dup.accessCount += 1;
				if (!dup.sourceTurn && record.sourceTurn) dup.sourceTurn = record.sourceTurn;
				this.writeAll(all);
				this.emit({ at: now, kind: "reinforced", memoryId: dup.memoryId, segment: dup.segment });
				return dup;
			}
		}

		// Embed-on-write (HYBRID recall vector lane, BOTH modes) — store a vector
		// for the vector lane. fs mode cosine-scans it in-app; convex mode ALSO
		// ANN-serves it via the built-in `by_embedding` vectorIndex at scale.
		// Embedding both modes keeps recall IDENTICAL across them (cross-mode
		// parity). Runs AFTER the write-gate AND after the dedup early-return so a
		// blocked (poisoned) OR deduped-away write pays no embedding cost; GUARDED
		// so a custom/learned embedder that throws degrades to no-vector (graceful
		// BM25-only recall for this fact) rather than failing the write. The bundled
		// embedder is synchronous + can't throw; an async model uses the async write
		// path (future).
		try {
			const v = getDefaultEmbedder().embed([record.content]);
			if (!(v instanceof Promise) && v[0]) record.embedding = v[0];
		} catch {
			/* embedder failure → no vector; this fact recalls via BM25 only */
		}

		// Archive superseded records (corrections/updates overwrite prior beliefs).
		if (record.supersedes) {
			const dead = new Set(record.supersedes);
			for (const r of all) {
				if (dead.has(r.memoryId) && r.lifecycle === "active") r.lifecycle = "archived";
			}
		}
		all.push(record);
		this.writeAll(all);
		this.emit({
			at: now,
			kind: "created",
			memoryId: record.memoryId,
			segment: record.segment,
			...(record.sourceType !== undefined ? { sourceType: record.sourceType } : {}),
			...((record.supersedes?.length ?? 0) + slotSuperseded.length > 0
				? { targets: [...(record.supersedes ?? []), ...slotSuperseded] }
				: {}),
		});
		return record;
	}

	/**
	 * Lexical recall over active facts — Okapi BM25 × `effectiveScore`
	 * (decay + importance), origin-filtered (the shared scorer, scoring.ts).
	 * The SAME scorer runs in fs (these `readAll` records) and convex mode
	 * (the hydrated cache) ⇒ cross-mode parity by construction. Marks every
	 * returned record accessed (recall reinforcement) unless `markAccessed:
	 * false`. Returns at most `limit` hits (default 8), each with its score.
	 */
	search(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		// Active + origin-matching candidates. Isolation is enforced HERE (never
		// inside the scorer): the origin filter is mandatory on every tool-facing
		// recall. `undefined` origin = the maintenance default (whole store) —
		// tool callers always pass an explicit filter.
		const now = Date.now();
		// Active + origin + still-valid (bi-temporal valid-time): a fact whose
		// `validTo` has passed is excluded from recall independent of lifecycle, so
		// a future-dated expiry written ahead of time stops surfacing on its own.
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) &&
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		// BM25 × effectiveScore (the shared v1 scorer). Identical code in fs +
		// convex (over readAll / the hydrated cache) ⇒ cross-mode parity by
		// construction. Replaces the old substring term-overlap.
		const top = bm25Score(candidates, query, now)
			.slice(0, limit)
			.map((s) => ({ ...s.record, score: s.score }));
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/**
	 * Hybrid recall (Tideline v2, convex lane) — BM25 ⊕ vector (cosine over each
	 * record's `embedding`), RRF-fused via `recallHybrid`. The vector lane only
	 * contributes for records that carry an embedding (populated on write in
	 * CONVEX mode; Convex's `by_embedding` vectorIndex serves the ANN at scale —
	 * this in-app cosine is the identical ranking over the hydrated cache). In fs
	 * mode there are no embeddings, so it gracefully degrades to pure BM25. Same
	 * active+origin candidate filter + reinforcement semantics as `search`.
	 */
	searchHybrid(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const now = Date.now();
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) && // bi-temporal valid-time gate (see search)
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		const top = recallHybrid(candidates, query, getDefaultEmbedder(), now, { limit }).map((f) => ({
			...f.record,
			score: f.score,
		}));
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/**
	 * The recall entry point live callers (auto-recall, recall_memory) use →
	 * the HYBRID lane (BM25 ⊕ vector, {@link searchHybrid}) in BOTH modes, so
	 * recall is identical fs ↔ convex (parity by construction, same as v1). The
	 * lower-level `search` stays a pure-lexical primitive for callers that want
	 * just BM25 (the eval floor, transparency).
	 */
	recall(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		return this.searchHybrid(query, opts);
	}

	/**
	 * Recall transparency (Tideline Step 11) — like `search` but returns each
	 * hit's {@link ScoreBreakdown} and does NOT reinforce decay (diagnostic +
	 * passive). Same candidate filtering (active + origin) and the same scorer,
	 * so the ranking matches `search` exactly — this just exposes the arithmetic
	 * (bm25 × modulator) behind each rank, for "why did this surface?" tooling.
	 */
	explainRecall(
		query: string,
		opts: { limit?: number; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number; breakdown: ScoreBreakdown }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const now = Date.now();
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) && // bi-temporal valid-time gate (see search)
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		return bm25Score(candidates, query, now, { breakdown: true })
			.slice(0, limit)
			.map((s) => ({ ...s.record, score: s.score, breakdown: s.breakdown as ScoreBreakdown }));
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

	/**
	 * Feedback-driven self-learning (the continual-learning loop's signal). `up`
	 * nudges importance (+ confidence if set) UP and reinforces decay; `down`
	 * nudges them DOWN — ASYMMETRIC (+0.05 / −0.10), so a
	 * few bad recalls outweigh many lukewarm ones. Persisted + logged to the event
	 * track (telemetry). Recall's trust/importance modulation then adapts, closing
	 * the loop: recall → feedback → better recall. Returns the updated record.
	 */
	applyFeedback(memoryId: string, signal: "up" | "down"): MemoryRecord | undefined {
		const all = this.readAll();
		const rec = all.find((r) => r.memoryId === memoryId);
		// Only LIVE facts take feedback (consistent with invalidate) — feeding back
		// an archived/pruned id would silently mutate a dead record to no effect.
		if (!rec || rec.lifecycle !== "active") return undefined;
		const delta = signal === "up" ? 0.05 : -0.1;
		const clamp = (x: number): number => Math.max(0, Math.min(1, x));
		rec.importance = clamp(rec.importance + delta);
		if (typeof rec.confidence === "number") rec.confidence = clamp(rec.confidence + delta);
		const now = Date.now();
		// `up` is a recall-and-keep → reinforce decay (bump access). `down` must NOT
		// touch the access clock: refreshing lastAccessedAt would reset the decay
		// timer and partly counteract the importance drop it just applied.
		if (signal === "up") {
			rec.lastAccessedAt = now;
			rec.accessCount += 1;
		}
		this.writeAll(all);
		this.emit({ at: now, kind: "feedback", memoryId, segment: rec.segment, signal });
		return rec;
	}

	/**
	 * Bi-temporally INVALIDATE a fact (Tideline v2, step 15) — close its valid
	 * interval (`validTo = now`) + archive it, so recall drops it while HISTORY
	 * keeps it (transaction time `createdAt` untouched). If `supersededBy` is
	 * given, records a `contradicts` link on the superseder → the stale fact.
	 * Persisted + logged. Returns the invalidated record, or `undefined` if it's
	 * missing / already inactive.
	 */
	invalidate(staleId: string, opts: { supersededBy?: string; now?: number } = {}): MemoryRecord | undefined {
		const all = this.readAll();
		const stale = all.find((r) => r.memoryId === staleId);
		if (!stale || stale.lifecycle !== "active") return undefined;
		const now = opts.now ?? Date.now();
		stale.validTo = now;
		stale.lifecycle = "archived";
		if (opts.supersededBy) {
			const by = all.find((r) => r.memoryId === opts.supersededBy);
			if (by) {
				const kept = (by.links ?? []).filter((l) => !(l.kind === "contradicts" && l.target === staleId));
				const links: MemoryLink[] = [...kept, { kind: "contradicts", target: staleId }];
				by.links = links;
			}
		}
		this.writeAll(all);
		this.emit({
			at: now,
			kind: "invalidated",
			memoryId: staleId,
			segment: stale.segment,
			...(opts.supersededBy ? { targets: [opts.supersededBy] } : {}),
		});
		return stale;
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
		// Convex mode — prime the cache (next readAll sees this write) and
		// enqueue per-record mutations realising the diff. All FactStore
		// mutators (write/markAccessed/setLifecycle/dedup-reinforce) funnel
		// through here, so this one branch covers every memory write path.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
			writeThroughFactsCache(rctx.store, wsId, records);
			return;
		}

		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
		const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, this.file);
	}
}
