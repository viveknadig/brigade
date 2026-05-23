/**
 * Brigade memory — public re-exports.
 *
 * Lets call sites (tools, agent-loop, gateway) import from one well-known
 * spot instead of reaching into the per-file modules. Internal files keep
 * the granular paths so circular imports stay easy to spot.
 */

export {
	FactStore,
	FACTS_RELATIVE_PATH,
	MEMORY_SEGMENTS,
	SEGMENT_DEFAULTS,
	clampImportance,
	makeMemoryId,
	type ListFilter,
	type MemoryLifecycle,
	type MemoryRecord,
	type MemorySegment,
	type MemoryTier,
	type NewFact,
} from "./records.js";

export {
	BrigadeMemoryPathError,
	FileMemoryStore,
	scoreChunk,
	splitIntoChunks,
	tokenize,
	type BrigadeStorage,
	type MemoryReadOptions,
	type MemoryReadResult,
	type MemorySearchOptions,
	type MemorySearchResult,
	type MemoryStatus,
} from "./storage.js";

export { buildAutoRecallBlock } from "./auto-recall.js";

export {
	createDefaultMemoryCapability,
	isDefaultMemoryCapability,
	resolveActiveMemoryCapability,
	type DefaultMemoryCapability,
	type DefaultMemoryHit,
} from "./plugin-runtime.js";
