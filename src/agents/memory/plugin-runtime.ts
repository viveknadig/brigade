/**
 * Brigade memory plugin SDK runtime — the seam between the built-in
 * file-based memory store (FactStore + FileMemoryStore) and an out-of-tree
 * `MemoryCapability` plugin.
 *
 * Goal: present Brigade's built-in memory through the SAME `MemoryCapability`
 * shape a plugin would register, so the tool layer (`recall_memory` /
 * `write_memory`) and the auto-recall injection don't care which is active —
 * they call `capability.search(query)` and `capability.recordFact(content)`
 * uniformly, and the slot resolver picks the active backend.
 *
 * Selection: `extensions.slots.memory` in `brigade.json`. When unset, the
 * default backend wins. When pinned to a registered capability id, that
 * plugin owns memory for the turn (vector DB, knowledge graph, sqlite-fts,
 * whatever the plugin author shipped).
 *
 * The default backend exports a slightly RICHER shape (`DefaultMemoryCapability`)
 * than the SDK contract — it surfaces the underlying `FactStore` results
 * (segment / importance / accessCount) and `FileMemoryStore` snippets
 * (relPath / startLine / endLine) so the built-in `recall_memory` tool can
 * render the same detailed output it has today when no plugin is pinned.
 * Plugins implementing only the public `MemoryCapability` interface degrade
 * gracefully to the minimal shape.
 */

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { MemoryCapability } from "../extensions/types.js";
import { FactStore, type MemoryRecord } from "./records.js";
import { FileMemoryStore, type MemorySearchResult } from "./storage.js";

/**
 * Rich result row produced by the default file-backed backend. Plugins are
 * not required to populate the extension fields; the recall_memory tool
 * checks `kind` and renders accordingly. The `id`/`content`/`score`/`source`
 * fields are the public `MemoryCapability` contract.
 */
export interface DefaultMemoryHit {
	id: string;
	content: string;
	score: number;
	source: "memory" | "session";
	/** Discriminant — present only on default-backend results. */
	kind?: "fact" | "note";
	/** Fact-only (default backend). */
	segment?: string;
	importance?: number;
	accessCount?: number;
	/** Note-only (default backend). */
	relPath?: string;
	startLine?: number;
	endLine?: number;
	snippet?: string;
}

/**
 * The default backend exposes its underlying stores so the recall_memory tool
 * can render the rich detail (segment / importance / file:line citations) it
 * always has, without paying for a second filesystem walk. Plugins don't
 * implement this extended surface — they only have to satisfy
 * `MemoryCapability` from the public SDK.
 */
export interface DefaultMemoryCapability extends MemoryCapability {
	readonly id: "brigade.memory.default";
	readonly fileStore: FileMemoryStore;
	readonly factStore: FactStore;
	/** Same as `search` but returns the rich rows the built-in tool renders. */
	searchRich(
		query: string,
		opts?: { limit?: number },
	): Promise<{ notes: MemorySearchResult[]; facts: Array<MemoryRecord & { score: number }> }>;
}

/**
 * Build a `MemoryCapability` that wraps the built-in `FactStore` +
 * `FileMemoryStore`. The result is interchangeable with a plugin-registered
 * capability — every consumer reads memory through `capability.search` /
 * `capability.recordFact` and never touches the stores directly.
 *
 * `searchRich` is the extension hook that lets the built-in recall_memory
 * tool keep its detailed rendering when this default is active; plugins
 * route through the minimal contract.
 */
export function createDefaultMemoryCapability(args: {
	workspaceDir: string;
	agentId?: string;
}): DefaultMemoryCapability {
	const fileStore = new FileMemoryStore(args.workspaceDir);
	const factStore = new FactStore(args.workspaceDir);

	const searchRich: DefaultMemoryCapability["searchRich"] = async (query, opts) => {
		const limit = opts?.limit;
		const notes = await fileStore.search(query, limit !== undefined ? { maxResults: limit } : {});
		const facts = factStore.search(query, limit !== undefined ? { limit } : {});
		return { notes, facts };
	};

	return {
		id: "brigade.memory.default",
		label: "Brigade file-based memory (built-in)",
		fileStore,
		factStore,
		searchRich,
		async search(query, opts) {
			const limit = opts?.limit;
			const { notes, facts } = await searchRich(query, limit !== undefined ? { limit } : {});
			const factHits: DefaultMemoryHit[] = facts.map((f) => ({
				id: f.memoryId,
				content: f.content,
				score: f.score,
				source: "memory" as const,
				kind: "fact" as const,
				segment: f.segment,
				importance: f.importance,
				accessCount: f.accessCount,
			}));
			const noteHits: DefaultMemoryHit[] = notes.map((n) => ({
				id: `${n.relPath}:${n.startLine}-${n.endLine}`,
				content: n.snippet,
				score: n.score,
				source: "session" as const,
				kind: "note" as const,
				relPath: n.relPath,
				startLine: n.startLine,
				endLine: n.endLine,
				snippet: n.snippet,
			}));
			// Facts first (structured signal wins ties), then notes. The
			// SDK contract is order-agnostic but consumers tend to render
			// the higher-signal block first.
			return [...factHits, ...noteHits];
		},
		async recordFact(content, opts) {
			// `meta.segment` / `meta.importance` are optional plugin-supplied
			// hints; default to a `context` fact when not provided, which is
			// what `write_memory` falls back to for ambient observations.
			const meta = opts?.meta ?? {};
			const segment = (meta.segment as string | undefined) ?? "context";
			const importanceStr = meta.importance;
			const importance =
				typeof importanceStr === "string" && Number.isFinite(Number(importanceStr))
					? Number(importanceStr)
					: undefined;
			const sourceTurn = typeof meta.sourceTurn === "string" ? meta.sourceTurn : undefined;
			const rec = factStore.write({
				content,
				// FactStore validates the segment against MEMORY_SEGMENTS; passing
				// an unknown segment falls back to `context` defaults internally.
				segment: segment as never,
				...(importance !== undefined ? { importance } : {}),
				...(sourceTurn ? { sourceTurn } : {}),
			});
			return { id: rec.memoryId };
		},
		async status() {
			// Counts active facts — the field consumers (`brigade doctor`)
			// care about most. Notes are an unbounded file tree; reporting
			// them here would be misleading without a separate breakdown.
			const itemCount = factStore.list({ lifecycle: "active" }).length;
			return { ready: true, itemCount };
		},
	};
}

/**
 * Resolve the active memory capability for a turn. When
 * `extensions.slots.memory` pins a registered plugin id, that plugin wins;
 * otherwise the built-in file-based default takes over. The result is the
 * single object every memory consumer (recall tool, write tool, auto-recall)
 * routes through — no per-call-site branching.
 */
export function resolveActiveMemoryCapability(args: {
	config: BrigadeConfig;
	registry: BrigadeExtensionRegistry;
	workspaceDir: string;
	agentId?: string;
}): MemoryCapability {
	const pinned = args.registry.resolveSlot("memory", args.config, args.registry.memoryCapabilities);
	if (pinned) return pinned;
	return createDefaultMemoryCapability({
		workspaceDir: args.workspaceDir,
		...(args.agentId ? { agentId: args.agentId } : {}),
	});
}

/**
 * Narrow a `MemoryCapability` to the default backend (truthy when the
 * built-in store is active). Lets the recall_memory tool decide whether to
 * render the rich notes+facts layout or the minimal plugin layout.
 */
export function isDefaultMemoryCapability(
	capability: MemoryCapability,
): capability is DefaultMemoryCapability {
	return capability.id === "brigade.memory.default";
}
