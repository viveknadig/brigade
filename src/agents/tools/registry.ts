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

import type { MemoryCapability } from "../extensions/types.js";
import { FileMemoryStore } from "../memory/storage.js";
import {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
} from "../memory/plugin-runtime.js";
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
	/**
	 * Active memory backend. The agent loop resolves this via
	 * `resolveActiveMemoryCapability(...)` so a plugin pinned through
	 * `extensions.slots.memory` automatically owns recall + write. Omitted →
	 * the registry builds the built-in file-backed default (back-compat with
	 * pre-SDK call sites + tests).
	 */
	memoryCapability?: MemoryCapability;
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
	// Primitive #4 (Memory): the active backend is a `MemoryCapability` — bundled
	// default (file-based FactStore + FileMemoryStore) when no plugin is pinned,
	// or a registered plugin (vector DB, KG, …) when `extensions.slots.memory`
	// selects one. The agent loop resolves and passes `memoryCapability`; tests
	// and legacy call sites omit it and get the default.
	const capability =
		opts.memoryCapability ?? createDefaultMemoryCapability({
			workspaceDir: opts.workspaceDir,
			agentId: opts.agentId,
		});
	// `read_memory` is filesystem-only (bounded read of MEMORY.md /
	// memory/<name>.md), so it always binds to the file store. When the active
	// capability IS the bundled default we reuse its store; otherwise we
	// construct one over the same workspaceDir so the read tool keeps
	// working alongside a plugin-backed search.
	const fileStore = isDefaultMemoryCapability(capability)
		? capability.fileStore
		: new FileMemoryStore(opts.workspaceDir);
	return [
		// recall routes through the capability (rich render for the default,
		// minimal SDK render for plugins).
		makeRecallMemoryTool(capability),
		makeReadMemoryTool(fileStore),
		// write_memory persists distilled structured facts through the capability.
		makeWriteMemoryTool(capability),
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
