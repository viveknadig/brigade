/**
 * The append-only event log — the immutable track of the dual-track spine
 * (Tideline build Step 7).
 *
 * The ACTIVE store (`FactStore`) holds current belief and is mutated in place
 * (supersede archives, dedup reinforces). The LOG is an ordered, append-only
 * record of WHAT HAPPENED, never rewritten. Together they are the dual track:
 * the store answers "what do I believe now?", the log answers "how did it get
 * this way?" — provenance, audit (every blocked poisoning attempt is recorded),
 * and a basis for rebuilding the store.
 *
 * v1 scope: FILESYSTEM mode appends to `<workspace>/memory/events.jsonl`. Convex
 * mode does NOT yet append — the active store + hydrated cache are authoritative
 * for recall (what v1 ships), and the convex `memoryEvents` table belongs to the
 * convex SERVER-side work validated by the live-deploy smoke (same boundary as
 * the rest of the convex backend). The log is additive provenance: its absence
 * never affects recall, so this asymmetry is safe for v1.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { MemorySegment, MemorySourceType } from "./records.js";

export type MemoryEventKind =
	| "created" // a new fact was persisted (carries `targets` if it superseded any)
	| "reinforced" // a near-duplicate write merged into an existing fact (decay bump)
	| "blocked" // the write-gate rejected a poisoning write (carries `reason`)
	| "feedback" // recall feedback adjusted a fact's importance/confidence (carries `signal`)
	| "invalidated"; // a fact was bi-temporally invalidated (validTo closed; carries the superseder in `targets`)

export interface MemoryEvent {
	/** Event time (ms). Stamped by the caller so it matches the record's time. */
	at: number;
	kind: MemoryEventKind;
	/** Subject record: the new/merged/attempted fact's id. */
	memoryId: string;
	segment?: MemorySegment;
	sourceType?: MemorySourceType;
	/** On "created": the ids this write superseded (archived). */
	targets?: string[];
	/** On "blocked": the write-gate reason. */
	reason?: string;
	/** On "feedback": the relevance signal that drove the importance/confidence update. */
	signal?: "up" | "down";
}

/** Append-only JSONL event log. Best-effort: a log failure NEVER fails a write
 *  (provenance must not be able to take down the active store). */
export class MemoryEventLog {
	constructor(private readonly file: string) {}

	get filePath(): string {
		return this.file;
	}

	append(event: MemoryEvent): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
		} catch {
			// Best-effort provenance — swallow (the active store already succeeded).
		}
	}

	/** Read the full ordered history. Malformed lines are skipped (never throws). */
	readAll(): MemoryEvent[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: MemoryEvent[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const e = JSON.parse(trimmed) as MemoryEvent;
				if (e && typeof e.memoryId === "string" && typeof e.kind === "string") out.push(e);
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		return out;
	}
}
