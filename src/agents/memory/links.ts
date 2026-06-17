/**
 * The links substrate — typed edges between memories (Tideline build Step 7,
 * the graph half of the dual-track spine).
 *
 * A fact can point at other facts: a correction supersedes a prior belief, an
 * extracted fact is `derived_from` its source, two facts may `contradict`. v1
 * STORES and DERIVES these edges (the substrate); multi-hop graph TRAVERSAL
 * (following links during recall to pull in related context) is deliberately
 * v2 — the field + the read primitives land now so the data accrues and the
 * v2 traversal has something to walk.
 *
 * Storage note: `supersedes[]` stays the supersede MECHANISM (it drives
 * archiving in `FactStore.write`); we do NOT duplicate it into `links[]` at
 * write time. Instead {@link linksFrom} mirrors it into a `supersedes` edge at
 * READ time so a graph view is complete without a migration or double-write.
 */

import type { MemoryRecord } from "./records.js";

/**
 * Typed edge kinds. `supersedes` is derived from the record's `supersedes[]`;
 * the rest are explicit (written into `links[]`). Surfaced, not auto-resolved —
 * a `contradicts` edge flags a conflict for consolidation, it doesn't pick a
 * winner.
 */
export type MemoryLinkKind =
	| "supersedes" // this fact replaces the target (the correction edge)
	| "corrects" // amends the target without fully replacing it
	| "relates" // generic association
	| "derived_from" // distilled/extracted from the target
	| "supports" // corroborates the target
	| "contradicts"; // conflicts with the target

export interface MemoryLink {
	kind: MemoryLinkKind;
	/** `memoryId` of the linked fact. */
	target: string;
}

/**
 * All outbound edges of a record — explicit `links[]` UNION the `supersedes[]`
 * mirrored as `supersedes` edges, deduped. This is the canonical "edges of this
 * node" view; storage keeps the two arrays separate (see module note).
 */
export function linksFrom(record: Pick<MemoryRecord, "links" | "supersedes">): MemoryLink[] {
	const mirrored: MemoryLink[] = (record.supersedes ?? []).map((target) => ({ kind: "supersedes", target }));
	const seen = new Set<string>();
	const out: MemoryLink[] = [];
	for (const l of [...(record.links ?? []), ...mirrored]) {
		const key = `${l.kind}|${l.target}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(l);
	}
	return out;
}

/**
 * Inbound edges to `targetId` across the corpus — the BACKLINKS. The substrate's
 * read primitive; v2 multi-hop recall walks these to pull related context.
 */
export function backlinksTo(
	records: readonly MemoryRecord[],
	targetId: string,
): Array<{ from: string; kind: MemoryLinkKind }> {
	const out: Array<{ from: string; kind: MemoryLinkKind }> = [];
	for (const r of records) {
		for (const l of linksFrom(r)) {
			if (l.target === targetId) out.push({ from: r.memoryId, kind: l.kind });
		}
	}
	return out;
}
