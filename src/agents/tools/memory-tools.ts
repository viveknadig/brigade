/**
 * Brigade memory tools — Primitive #4. Two READ tools, exactly mirroring
 * OpenClaw's `memory_search` + `memory_get` (`extensions/memory-core/
 * src/tools.ts`):
 *
 *   - `recall_memory` — lexical search across MEMORY.md + memory/*.md,
 *     returns scored snippets. The "search before you answer" tool.
 *   - `read_memory`   — bounded excerpt read of one memory file.
 *
 * There is NO write tool, by design — the agent appends durable facts to
 * `memory/<today>.md` using its ordinary `write` / `edit` tool (Pi's
 * session cwd is the workspace dir, so a relative path lands in the right
 * place). This is precisely OpenClaw's model; Brigade's locked skill spec
 * lists a `write_memory` tool but the operator chose to mirror OpenClaw
 * for v1 and revisit a dedicated write tool later.
 *
 * Both tools delegate to a `BrigadeStorage` instance, so Phase 2's
 * DB-backed store drops in without touching the tool code.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	BrigadeMemoryPathError,
	type BrigadeStorage,
	type MemoryReadResult,
	type MemorySearchResult,
} from "../memory/storage.js";
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

interface RecallMemoryDetails {
	query: string;
	resultCount: number;
	results: MemorySearchResult[];
}

/**
 * Build the `recall_memory` tool bound to a storage instance.
 */
export function makeRecallMemoryTool(
	store: BrigadeStorage,
): BrigadeTool<typeof RecallMemoryParams, RecallMemoryDetails> {
	return {
		name: "recall_memory",
		label: "recall memory",
		displaySummary: "searching memory",
		description:
			"Search your durable memory (MEMORY.md + memory/*.md daily notes) for relevant " +
			"facts before answering. Use this whenever the user refers to past context, " +
			"their preferences, project conventions, or anything you might have noted earlier. " +
			"Returns scored snippets with the file + line range each came from; follow up with " +
			"read_memory to pull the full surrounding text.",
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
			const details: RecallMemoryDetails = {
				query,
				resultCount: results.length,
				results,
			};
			if (results.length === 0) {
				return textResult(
					`No memory matched "${query}". Nothing has been noted about this yet — ` +
						`if it's worth remembering, write it to memory/<today>.md.`,
					details,
				);
			}
			const rendered = results
				.map((r, i) => {
					const loc = `${r.relPath}:${r.startLine}-${r.endLine}`;
					return `[${i + 1}] ${loc} (score ${r.score.toFixed(1)})\n${r.snippet}`;
				})
				.join("\n\n");
			return textResult(
				`Found ${results.length} memory snippet${results.length === 1 ? "" : "s"} for "${query}":\n\n${rendered}`,
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
