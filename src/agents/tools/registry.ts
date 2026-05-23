/**
 * Brigade tool registry.
 *
 * Factory that builds the array of Brigade-native custom tools passed to
 * Pi's `createAgentSession({customTools})` slot. Today it returns the three
 * Primitive #4 memory tools — `recall_memory` (lexical search across markdown
 * notes + the structured fact store), `read_memory` (fetch a specific note),
 * and `write_memory` (persist a structured fact) — alongside Pi's built-in
 * tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`). `spawn_agent`
 * ships with Primitive #6 (sub-agents).
 *
 * The factory is plumbed through `session-wiring.ts` (the single
 * tool-assembly seam) so adding a tool later is a one-line change in
 * `createBrigadeTools` rather than a multi-file rewire.
 *
 * Tool-factory pattern with Brigade-native naming and a deliberately
 * narrow scope (no plugins, no channels, no MCP).
 */

import { FileMemoryStore } from "../memory/storage.js";
import { FactStore } from "../memory/records.js";
import { makeReadMemoryTool, makeRecallMemoryTool, makeWriteMemoryTool } from "./memory-tools.js";
import type { AnyBrigadeTool } from "./types.js";

/**
 * Options threaded through to every Brigade-native tool. Each tool
 * picks the fields it needs; the rest are ignored.
 *
 * Per-field rationale:
 *   - `workspaceDir` — the absolute path to `~/.brigade/workspace/`.
 *     Persona-mutating tools (write_memory, recall_memory) resolve
 *     their target files under this root. The agent's session cwd
 *     defaults to this dir so Pi's built-in write/edit/read resolve
 *     relative paths into it naturally; Brigade-native tools take it
 *     as an explicit parameter so they're not coupled to that default.
 *   - `agentId` — the active agent id (default `"main"`). Sub-agent
 *     tools (`spawn_agent`) use this to scope nested sessions.
 *   - `cwd` — process cwd. Tools that need to resolve relative paths
 *     for read-only operations (grep / ls equivalents) can choose to
 *     resolve against cwd OR workspaceDir depending on intent.
 */
export interface CreateBrigadeToolsOptions {
	workspaceDir: string;
	agentId: string;
	cwd: string;
}

/**
 * Build Brigade's custom tool array — the THREE Primitive #4 memory tools
 * today (recall_memory, read_memory, write_memory); skills (#5) and
 * sub-agents (#6) add more later. Callers pass the result to Pi's
 * `customTools` option — Pi merges it with the `tools` allowlist (built-ins
 * by name) to form the full tool surface.
 *
 * The function takes options eagerly rather than late-binding so tests can
 * construct a deterministic registry without touching the filesystem.
 */
export function createBrigadeTools(opts: CreateBrigadeToolsOptions): AnyBrigadeTool[] {
	// Primitive #4 (Memory): markdown notes via `FileMemoryStore` (recall/read)
	// + structured facts via `FactStore` (recall/write). Stores are constructed
	// per-turn from the workspace dir; they're stateless (filesystem-backed), so
	// there's no lifecycle to manage. Phase 2 swaps `FileMemoryStore` for a
	// DB-backed `BrigadeStorage` here without touching the tools or the prompt.
	const memoryStore = new FileMemoryStore(opts.workspaceDir);
	const factStore = new FactStore(opts.workspaceDir);
	return [
		// recall searches BOTH markdown notes (memoryStore) and structured
		// facts (factStore), reinforcing recalled facts against decay.
		makeRecallMemoryTool(memoryStore, factStore),
		makeReadMemoryTool(memoryStore),
		// write_memory persists distilled structured facts.
		makeWriteMemoryTool(factStore),
	];
}

/**
 * Names of Brigade-native tools shipped today. Used by the system-prompt
 * assembler to advertise tools by name in the `## Tooling` section AND by
 * `agent-loop.ts` to flip on the memory-capability prompt block.
 */
export function listBrigadeToolNames(): string[] {
	return ["recall_memory", "read_memory", "write_memory"];
}
