/**
 * Tideline gold set — the cases the eval harness scores (build Step 2).
 *
 * A gold set is a corpus of FACTS plus CASES (a query + which facts should
 * surface). Facts are addressed by a stable logical `key` so a case can name
 * its relevant facts BEFORE their `memoryId`s exist; `seedGold` writes the
 * facts into a `FactStore`, captures key→memoryId, applies supersedes (so
 * knowledge-update / transition cases archive the stale fact), and resolves
 * each case's `relevantKeys` into the `relevantIds` the harness compares
 * against. EMPTY `relevantKeys` ⇒ an abstention case.
 *
 * Two sources, per the plan: the SYNTHETIC hard cases here (self-contained,
 * runnable today) and — exported + decrypted + human-approved — the
 * operator's REAL Convex facts (`loadGoldSpec` reads that JSON; built jointly).
 */

import * as fs from "node:fs";

import { FactStore, MEMORY_SEGMENTS, type MemoryRecordOrigin, type MemorySegment, type NewFact } from "../records.js";
import type { EvalCase } from "./harness.js";

/** A fact in a gold corpus, addressed by a stable logical `key`. */
export interface GoldFact {
	key: string;
	content: string;
	segment: MemorySegment;
	importance?: number;
	createdBy?: MemoryRecordOrigin;
	/** keys this fact supersedes (knowledge-update / transition) — those facts
	 *  must already be listed EARLIER in `facts` (they're written first). */
	supersedesKeys?: string[];
}

/** A gold case referencing relevant facts by their logical key. */
export interface GoldCase {
	id: string;
	query: string;
	/** logical keys of facts that SHOULD surface. EMPTY ⇒ abstention. */
	relevantKeys: string[];
	category: string;
}

export interface GoldSpec {
	facts: GoldFact[];
	cases: GoldCase[];
}

/**
 * Seed `store` with the spec's facts (in order, so supersede targets exist)
 * and resolve its cases into `EvalCase`s. Returns the cases ready for
 * `runRecallEval`. Throws on a case referencing an unknown fact key — a typo
 * in a gold set should fail loud, not silently score zero.
 */
export function seedGold(store: FactStore, spec: GoldSpec): EvalCase[] {
	const keyToId = new Map<string, string>();
	const seenIds = new Set<string>();
	for (const f of spec.facts) {
		// Keys must be unique — a duplicate would silently overwrite in keyToId
		// and a case could then resolve to the wrong fact.
		if (keyToId.has(f.key)) {
			throw new Error(`gold fact "${f.key}": duplicate fact key — keys must be unique`);
		}
		const supersedes = f.supersedesKeys?.map((k) => {
			const id = keyToId.get(k);
			if (!id) {
				throw new Error(`gold fact "${f.key}": supersedesKey "${k}" must be listed earlier in facts`);
			}
			return id;
		});
		const nf: NewFact = {
			content: f.content,
			segment: f.segment,
			...(f.importance !== undefined ? { importance: f.importance } : {}),
			...(f.createdBy !== undefined ? { createdBy: f.createdBy } : {}),
			...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
		};
		const rec = store.write(nf);
		// Fail loud on a write-time dedup collision: FactStore.write merges a
		// near-identical same-origin fact into an existing record and returns THAT
		// id, so two distinct gold keys could silently map to one memoryId —
		// corrupting relevance labels. Gold facts must stay distinct.
		if (seenIds.has(rec.memoryId)) {
			throw new Error(
				`gold fact "${f.key}": write-time dedup merged it into an earlier fact (id ${rec.memoryId}). ` +
					`Make its content less similar to a sibling, or give it a distinct supersedesKey.`,
			);
		}
		seenIds.add(rec.memoryId);
		keyToId.set(f.key, rec.memoryId);
	}
	// Fail loud if a later correction/slot-supersede write ARCHIVED a fact a case
	// still references: store.list() is active-only, so its label would silently
	// score zero. (Extends the dedup-collision fail-loud above to the content/slot
	// auto-supersede path.)
	const activeIds = new Set(store.list().map((r) => r.memoryId));
	return spec.cases.map((c) => ({
		id: c.id,
		query: c.query,
		relevantIds: c.relevantKeys.map((k) => {
			const id = keyToId.get(k);
			if (!id) throw new Error(`gold case "${c.id}": unknown fact key "${k}"`);
			if (!activeIds.has(id)) {
				throw new Error(
					`gold case "${c.id}": fact key "${k}" resolved to a record archived by a later ` +
						`supersede/correction write — its relevance label would silently score zero.`,
				);
			}
			return id;
		}),
		category: c.category,
	}));
}

/** The taxonomy buckets a gold set should cover (the harness groups by these). */
export const GOLD_CATEGORIES = [
	"single-session",
	"multi-session",
	"temporal",
	"knowledge-update",
	"preference",
	"abstention",
	"model-switch",
	"transition",
] as const;

/** Load a gold spec from a JSON file (the real-data path: export + decrypt the
 *  operator's Convex facts → human-approved cases → this JSON). Validates shape. */
export function loadGoldSpec(jsonPath: string): GoldSpec {
	const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as GoldSpec;
	if (!Array.isArray(raw.facts) || !Array.isArray(raw.cases)) {
		throw new Error(`gold spec at ${jsonPath} must have { facts: [], cases: [] }`);
	}
	raw.facts.forEach((f, i) => {
		if (typeof f?.key !== "string" || typeof f?.content !== "string" || typeof f?.segment !== "string") {
			throw new Error(`gold spec at ${jsonPath}: facts[${i}] needs string key, content, and segment`);
		}
		// Validate segment against the known set — an unknown/typo'd segment would
		// silently degrade to `context` defaults (skewing tier/importance/decay).
		if (!(MEMORY_SEGMENTS as readonly string[]).includes(f.segment)) {
			throw new Error(`gold spec at ${jsonPath}: facts[${i}] has unknown segment "${f.segment}"`);
		}
	});
	raw.cases.forEach((c, i) => {
		if (typeof c?.id !== "string" || typeof c?.query !== "string") {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] needs string id and query`);
		}
		if (!Array.isArray(c.relevantKeys)) {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) needs an array relevantKeys`);
		}
		if (!c.relevantKeys.every((k) => typeof k === "string")) {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) relevantKeys must all be strings`);
		}
		if (typeof c.category !== "string") {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) needs a string category`);
		}
	});
	return raw;
}
