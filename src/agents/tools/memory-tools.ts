/**
 * Brigade memory tools — Primitive #4. Three tools:
 *
 *   - `recall_memory` — lexical search across MEMORY.md + memory/*.md daily
 *     notes (markdown, via BrigadeStorage) AND the structured fact store
 *     (memory/facts.jsonl, via FactStore).
 *   - `read_memory`   — bounded excerpt read of one memory file.
 *   - `write_memory`  — persist a structured durable fact: one sentence +
 *     segment + importance. Recall hits bump the fact's accessCount (decay
 *     reinforcement); the post-turn extraction subagent writes through
 *     the same store.
 *
 * Markdown reads/searches go through `BrigadeStorage` (Phase-2 DB-swap seam);
 * structured facts go through `FactStore`. Daily-note free-form writes still
 * use the ordinary `write`/`edit` tool against the workspace cwd — `write_memory`
 * is for distilled, taggable facts.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	BrigadeMemoryPathError,
	type BrigadeStorage,
	type MemoryReadResult,
	type MemorySearchResult,
} from "../memory/storage.js";
import { type FactStore, MEMORY_SEGMENTS, type MemorySegment } from "../memory/records.js";
import { readNumberParam, readStringParam, textResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

/* ───────────────────────── recall_memory (search) ───────────────────────── */

const RecallMemoryParams = Type.Object({
	query: Type.String({
		description:
			"What to look for in memory. Free text — keywords or a phrase. " +
			"Searches MEMORY.md plus the daily notes under memory/.",
	}),
	maxResults: Type.Optional(
		Type.Number({
			description: "Maximum number of memory snippets to return (default 8).",
		}),
	),
});

interface RecalledFact {
	memoryId: string;
	content: string;
	segment: string;
	importance: number;
	score: number;
}

interface RecallMemoryDetails {
	query: string;
	resultCount: number;
	results: MemorySearchResult[];
	facts: RecalledFact[];
}

/**
 * Build the `recall_memory` tool. Searches markdown memory (BrigadeStorage)
 * and, when a FactStore is supplied, the structured fact store too — merging
 * both into one ranked result set and reinforcing recalled facts.
 */
export function makeRecallMemoryTool(
	store: BrigadeStorage,
	factStore?: FactStore,
): BrigadeTool<typeof RecallMemoryParams, RecallMemoryDetails> {
	return {
		name: "recall_memory",
		label: "recall memory",
		displaySummary: "searching memory",
		description:
			"Search your durable memory — structured facts plus MEMORY.md and memory/*.md daily " +
			"notes — for relevant context before answering. Use this whenever the user refers to " +
			"past context, their preferences, project conventions, or anything you might have noted " +
			"earlier. Returns matching facts and scored note snippets (with file + line range); " +
			"follow up with read_memory to pull the full surrounding text of a note.",
		parameters: RecallMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<RecallMemoryDetails>> {
			const query = readStringParam(params as Record<string, unknown>, "query", {
				required: true,
				label: "query",
			});
			const maxResults = readNumberParam(params as Record<string, unknown>, "maxResults", {
				integer: true,
				label: "maxResults",
			});
			const results = await store.search(query, maxResults ? { maxResults } : {});
			// Structured facts (memory/facts.jsonl). Searching marks hits accessed
			// so frequently-recalled facts resist decay.
			const factHits = (factStore?.search(query, maxResults ? { limit: maxResults } : {}) ?? []).map(
				(r) => ({
					memoryId: r.memoryId,
					content: r.content,
					segment: r.segment,
					importance: r.importance,
					score: r.score,
				}),
			);
			const details: RecallMemoryDetails = {
				query,
				resultCount: results.length + factHits.length,
				results,
				facts: factHits,
			};
			if (results.length === 0 && factHits.length === 0) {
				return textResult(
					`No memory matched "${query}". Nothing has been noted about this yet — ` +
						`if it's worth remembering, use write_memory (or jot it in memory/<today>.md).`,
					details,
				);
			}
			const sections: string[] = [];
			if (factHits.length > 0) {
				sections.push(
					"Facts:\n" +
						factHits
							.map((f) => `- [${f.segment}] ${f.content} (importance ${f.importance.toFixed(2)})`)
							.join("\n"),
				);
			}
			if (results.length > 0) {
				sections.push(
					"Notes:\n" +
						results
							.map((r, i) => {
								const loc = `${r.relPath}:${r.startLine}-${r.endLine}`;
								return `[${i + 1}] ${loc} (score ${r.score.toFixed(1)})\n${r.snippet}`;
							})
							.join("\n\n"),
				);
			}
			return textResult(
				`Found ${details.resultCount} memory match${details.resultCount === 1 ? "" : "es"} for "${query}":\n\n${sections.join("\n\n")}`,
				details,
			);
		},
	};
}

/* ───────────────────────── read_memory (get) ───────────────────────── */

const ReadMemoryParams = Type.Object({
	path: Type.String({
		description:
			'Memory file to read. Either "MEMORY.md" or "memory/<name>.md" ' +
			"(e.g. a daily note like memory/2026-05-21.md). Relative to the workspace.",
	}),
	from: Type.Optional(
		Type.Number({ description: "1-based line to start reading from (default 1)." }),
	),
	lines: Type.Optional(
		Type.Number({ description: "Number of lines to read (default 200, max 1000)." }),
	),
});

interface ReadMemoryDetails {
	read?: MemoryReadResult;
	status: "ok" | "failed";
	error?: string;
}

/**
 * Build the `read_memory` tool bound to a storage instance.
 */
export function makeReadMemoryTool(
	store: BrigadeStorage,
): BrigadeTool<typeof ReadMemoryParams, ReadMemoryDetails> {
	return {
		name: "read_memory",
		label: "read memory",
		displaySummary: "reading memory",
		description:
			"Read a bounded excerpt of a memory file (MEMORY.md or a memory/<name>.md daily " +
			"note). Use after recall_memory to pull the full context around a snippet. " +
			"Reads are line-windowed; if the result is truncated, read again from the " +
			"reported next line.",
		parameters: ReadMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadMemoryDetails>> {
			const relPath = readStringParam(params as Record<string, unknown>, "path", {
				required: true,
				label: "path",
			});
			const from = readNumberParam(params as Record<string, unknown>, "from", {
				integer: true,
				label: "from",
			});
			const lines = readNumberParam(params as Record<string, unknown>, "lines", {
				integer: true,
				label: "lines",
			});
			try {
				const result = await store.read(relPath, {
					...(from !== undefined ? { from } : {}),
					...(lines !== undefined ? { lines } : {}),
				});
				const header = result.truncated
					? `${result.relPath} (lines ${result.from}-${result.from + result.lines - 1}, more from line ${result.nextFrom}):`
					: `${result.relPath} (lines ${result.from}-${result.from + result.lines - 1}):`;
				return textResult(`${header}\n\n${result.text}`, {
					status: "ok",
					read: result,
				});
			} catch (err) {
				// Path-scope violations + missing files surface as a clear
				// tool-result the model can act on (search instead, or write
				// the file). Re-throw anything unexpected so Pi logs it.
				if (err instanceof BrigadeMemoryPathError) {
					return textResult(err.message, { status: "failed", error: err.message });
				}
				throw err;
			}
		},
	};
}

/* ───────────────────────── write_memory ───────────────────────── */

const WriteMemoryParams = Type.Object({
	content: Type.String({
		description:
			"One clear declarative sentence to remember durably. " +
			'E.g. "The user prefers spaces over tabs." Keep it self-contained.',
	}),
	segment: Type.Union(
		MEMORY_SEGMENTS.map((s) => Type.Literal(s)),
		{
			description:
				"What kind of fact: identity (who they are) · preference (how they like things) · " +
				"correction (fixing a prior belief — set supersedes) · relationship (people) · " +
				"project (work/conventions) · knowledge (durable facts) · context (ongoing state).",
		},
	),
	importance: Type.Optional(
		Type.Number({ description: "0..1 importance. Omit to use the segment's default." }),
	),
	supersedes: Type.Optional(
		Type.Array(Type.String(), {
			description: "memoryIds this fact replaces (use for corrections/updates).",
		}),
	),
});

interface WriteMemoryDetails {
	memoryId: string;
	segment: string;
	importance: number;
}

/**
 * Build the `write_memory` tool bound to a FactStore. Persists a single
 * distilled fact tagged by segment, with tier/importance/decay derived
 * from that segment.
 */
export function makeWriteMemoryTool(
	factStore: FactStore,
): BrigadeTool<typeof WriteMemoryParams, WriteMemoryDetails> {
	return {
		name: "write_memory",
		label: "write memory",
		displaySummary: "saving to memory",
		description:
			"Persist a durable fact to long-term memory. Prefer aggressive writing — memory is " +
			"cheap, forgetting is expensive. Save the user's identity, preferences, corrections, " +
			"project conventions, relationships, and ongoing context. Skip transient things " +
			'("I\'m tired right now"). One clear sentence per fact. For a correction, set ' +
			"segment=correction and pass the prior fact's id in supersedes.",
		parameters: WriteMemoryParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<WriteMemoryDetails>> {
			const p = params as Record<string, unknown>;
			const content = readStringParam(p, "content", { required: true, label: "content" });
			const segment = readStringParam(p, "segment", {
				required: true,
				label: "segment",
			}) as MemorySegment;
			const importance = readNumberParam(p, "importance", { label: "importance" });
			const supersedes = Array.isArray(p.supersedes)
				? (p.supersedes as unknown[]).filter((x): x is string => typeof x === "string")
				: undefined;
			const rec = factStore.write({
				content,
				segment,
				...(importance !== undefined ? { importance } : {}),
				...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
			});
			return textResult(
				`Remembered [${rec.segment}, importance ${rec.importance.toFixed(2)}]: ${rec.content}`,
				{ memoryId: rec.memoryId, segment: rec.segment, importance: rec.importance },
			);
		},
	};
}
