// src/agents/memory/vault.ts
//
// Tideline Step 21 — the Obsidian markdown vault.
//
// Renders each fact as a markdown note: YAML frontmatter (id / segment / tier /
// status + typed `links` as a Bases-friendly array) over the content body,
// followed by a PINNED region the human owns.
//
// 3-WAY MERGE (the load-bearing property): the dream/system PROPOSES a fresh
// render, but a human-edited PINNED region (between the `%% pinned %%` markers)
// is spliced back in verbatim — the system never clobbers hand edits. So
// re-rendering after a dream pass updates the frontmatter + body while the
// human's notes survive untouched. In convex mode the vault is a read-only
// render (filesystem is the source of truth); only `writeVault` mutates disk.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { linksFrom } from "./links.js";
import type { MemoryRecord } from "./records.js";

const PIN_OPEN = "%% pinned %%";
const PIN_CLOSE = "%% /pinned %%";

function yamlValue(v: string): string {
	// Bare when unambiguous; otherwise a JSON string IS a valid YAML double-quoted
	// scalar — it escapes backslash, quote, AND control chars (newline/tab/…),
	// which a hand-rolled quote-only escape would corrupt into invalid frontmatter.
	return /^[A-Za-z0-9 _./-]+$/.test(v) ? v : JSON.stringify(v);
}

function renderFrontmatter(r: MemoryRecord): string {
	const lines = ["---", `id: ${yamlValue(r.memoryId)}`, `segment: ${r.segment}`, `tier: ${r.tier}`];
	if (r.status) lines.push(`status: ${r.status}`);
	if (r.subjectKey) lines.push(`subject: ${yamlValue(r.subjectKey)}`);
	if (typeof r.confidence === "number") lines.push(`confidence: ${r.confidence}`);
	const links = linksFrom(r);
	if (links.length > 0) {
		lines.push("links:");
		for (const l of links) lines.push(`  - ${yamlValue(`${l.kind}:${l.target}`)}`);
	}
	lines.push("---");
	return lines.join("\n");
}

/** Render a fact to a full markdown note (frontmatter + body + empty pin region). */
export function renderNote(r: MemoryRecord): string {
	return `${renderFrontmatter(r)}\n\n${r.content}\n\n${PIN_OPEN}\n\n${PIN_CLOSE}\n`;
}

/**
 * Extract the pinned region's INNER text. Anchored to the note TAIL: uses the
 * LAST `%% pinned %%` (so a marker smuggled into the fact body can't hijack the
 * region), and if the close marker is missing/mangled, captures OPEN→EOF rather
 * than silently discarding the human's edits. `undefined` when no open marker.
 */
export function extractPinned(md: string): string | undefined {
	const o = md.lastIndexOf(PIN_OPEN);
	if (o === -1) return undefined;
	const after = md.slice(o + PIN_OPEN.length);
	const c = after.indexOf(PIN_CLOSE);
	return c === -1 ? after : after.slice(0, c);
}

/**
 * 3-way merge: take the `proposed` render but splice the EXISTING note's pinned
 * region back in, so a human edit survives a re-render. Tail-anchored (matches
 * extractPinned). No existing note / no pin region → `proposed` unchanged.
 */
export function mergeNote(existing: string | undefined, proposed: string): string {
	if (!existing) return proposed;
	const pinned = extractPinned(existing);
	if (pinned === undefined) return proposed;
	const o = proposed.lastIndexOf(PIN_OPEN);
	if (o === -1) return proposed;
	const afterStart = o + PIN_OPEN.length;
	const cRel = proposed.slice(afterStart).indexOf(PIN_CLOSE);
	const cAbs = cRel === -1 ? proposed.length : afterStart + cRel;
	return proposed.slice(0, afterStart) + pinned + proposed.slice(cAbs);
}

function noteFileName(memoryId: string): string {
	const safe = memoryId.replace(/[^A-Za-z0-9_-]/g, "_");
	// If sanitisation changed the id, distinct ids could collapse to one file —
	// disambiguate with a short content hash so the on-disk name is a bijection.
	if (safe === memoryId) return `${safe}.md`;
	return `${safe}-${createHash("sha1").update(memoryId).digest("hex").slice(0, 8)}.md`;
}

export interface VaultWriteResult {
	written: number;
	/** Notes whose pinned region was preserved from a prior hand edit. */
	mergedPinned: number;
	/** Stale notes removed (only when `prune` is set). */
	pruned?: number;
}

/**
 * Write/refresh the vault for `records` under `dir`, preserving pinned edits.
 *
 * `prune` (default OFF) removes any `.md` note in `dir` NOT in the current record
 * set — so an evicted/PURGED fact's note can't linger as plaintext on disk after
 * a crypto-shred (the integrity counterpart to {@link FactStore.purge}). Callers
 * that pass the FULL set for a vault (e.g. the whole owner origin) should enable
 * it; callers passing a partial set must not.
 */
export function writeVault(
	dir: string,
	records: readonly MemoryRecord[],
	opts: { prune?: boolean } = {},
): VaultWriteResult {
	fs.mkdirSync(dir, { recursive: true });
	let written = 0;
	let mergedPinned = 0;
	const keep = new Set<string>();
	for (const r of records) {
		const name = noteFileName(r.memoryId);
		keep.add(name);
		const file = path.join(dir, name);
		const proposed = renderNote(r);
		let existing: string | undefined;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch {
			existing = undefined;
		}
		const pinned = existing ? extractPinned(existing) : undefined;
		const merged = mergeNote(existing, proposed);
		if (pinned !== undefined && pinned.trim().length > 0) mergedPinned++;
		fs.writeFileSync(file, merged, "utf8");
		written++;
	}
	if (!opts.prune) return { written, mergedPinned };

	// Remove stale notes (a purged/evicted fact must not survive as plaintext).
	let pruned = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		entries = [];
	}
	for (const f of entries) {
		if (f.endsWith(".md") && !keep.has(f)) {
			try {
				fs.rmSync(path.join(dir, f));
				pruned++;
			} catch {
				/* concurrent removal / locked — best effort */
			}
		}
	}
	return { written, mergedPinned, pruned };
}
