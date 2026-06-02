/**
 * File-backed session store: `brigade-store.json`.
 *
 * Brand-scrubbed analogue of upstream `src/config/sessions/store.ts`, scoped
 * down to what Brigade's gateway + sub-agent registry actually need today:
 *
 *   - Atomic save (`tmp + rename`, see `infra/json-file.ts`)
 *   - Per-storePath FIFO lock via `./session-store-lock.ts`
 *   - Case-insensitive session-key resolution with legacy-key carry-over
 *   - `updateSessionStore<T>(mutator)` for read-modify-write semantics
 *
 * What's intentionally DROPPED vs. upstream (until a later step needs them):
 *
 *   - Maintenance sweeps (prune-stale / cap-entries / rotate)
 *   - Disk-budget enforcer
 *   - Per-storePath serialized-content cache (`store-cache.ts`)
 *   - Session-archive runtime + cross-link cleanup
 *   - Delivery-context normalisation hooks
 *   - ACP-metadata preservation
 *
 * Adding any of those is additive — none of the public APIs here need to
 * change for the maintenance layer to slot in later.
 *
 * Note: Brigade also has `src/sessions/session-store.ts`, which manages a
 * DIFFERENT data file (`sessions.json` per-agent JSONL transcript index).
 * This file at `agents/session-store.ts` owns the cross-agent
 * `brigade-store.json` registry consumed by Step 10's sub-agent registry
 * and Step 11's session context.
 */

import fs from "node:fs";
import path from "node:path";

import { saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveStateDir } from "../config/paths.js";
import { withSessionStoreLock } from "./session-store-lock.js";

const log = createSubsystemLogger("agents/session-store");

/**
 * Session-entry shape stored in `brigade-store.json`.
 *
 * Brigade tracks the minimal set of fields the gateway + registry need
 * today; extra fields are preserved through round-trips via the index
 * signature. New consumers should narrow with their own typed views
 * rather than widening this base interface.
 */
export interface SessionEntry {
	sessionId: string;
	/** Milliseconds since epoch when this entry was last modified. */
	updatedAt: number;
	/** Path to the JSONL transcript file (if persisted). */
	sessionFile?: string;
	/** Session key of the immediate parent (where the spawn was issued). */
	spawnedBy?: string;
	/** Workspace directory inherited by spawned sessions. */
	spawnedWorkspaceDir?: string;
	/** Spawn depth: 0 = main session, 1+ = sub-agents of sub-agents. */
	spawnDepth?: number;
	/** Runtime status used by the registry sweeper. */
	status?: "running" | "done" | "failed" | "killed" | "timeout";
	/** First-run start time (ms), persisted after completion. */
	startedAt?: number;
	/** Latest completed run end time (ms). */
	endedAt?: number;
	/** Accumulated runtime across follow-up runs (ms). */
	runtimeMs?: number;
	/** Unknown fields survive a load/save round-trip. */
	[key: string]: unknown;
}

export function normalizeStoreSessionKey(sessionKey: string): string {
	return normalizeLowercaseStringOrEmpty(sessionKey);
}

/**
 * Resolve an entry across legacy/case-variant keys.
 *
 * The store is canonically keyed lowercase. Older snapshots may carry the
 * raw mixed-case key; this helper finds those too and surfaces them as
 * `legacyKeys` so the caller can rewrite + delete in one pass.
 *
 * If multiple variants exist, the one with the highest `updatedAt` wins.
 */
export function resolveSessionStoreEntry(params: {
	store: Record<string, SessionEntry>;
	sessionKey: string;
}): {
	normalizedKey: string;
	existing: SessionEntry | undefined;
	legacyKeys: string[];
} {
	const trimmedKey = params.sessionKey.trim();
	const normalizedKey = normalizeStoreSessionKey(trimmedKey);
	const legacyKeySet = new Set<string>();
	if (
		trimmedKey !== normalizedKey &&
		Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
	) {
		legacyKeySet.add(trimmedKey);
	}
	let existing =
		params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
	let existingUpdatedAt = existing?.updatedAt ?? 0;
	for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
		if (candidateKey === normalizedKey) continue;
		if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) continue;
		legacyKeySet.add(candidateKey);
		const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
		if (!existing || candidateUpdatedAt > existingUpdatedAt) {
			existing = candidateEntry;
			existingUpdatedAt = candidateUpdatedAt;
		}
	}
	return { normalizedKey, existing, legacyKeys: [...legacyKeySet] };
}

function loadSessionStoreUnlocked(storePath: string): Record<string, SessionEntry> {
	try {
		if (!fs.existsSync(storePath)) return {};
		const raw = fs.readFileSync(storePath, "utf8");
		if (!raw.trim()) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed && !Array.isArray(parsed)
			? (parsed as Record<string, SessionEntry>)
			: {};
	} catch (err) {
		log.warn("failed to load session store; treating as empty", {
			storePath,
			error: (err as Error)?.message,
		});
		return {};
	}
}

async function saveSessionStoreUnlocked(
	storePath: string,
	store: Record<string, SessionEntry>,
): Promise<void> {
	// `saveJsonFile` is sync + atomic (tmp + rename, mode 0o600). The async
	// wrapper here keeps the call site await-friendly so future maintenance
	// hooks can land without rewriting every caller.
	saveJsonFile(storePath, store);
}

/**
 * Canonical path resolver for the cross-agent registry store.
 *
 * Defaults to `<stateDir>/brigade-store.json`. Callers building isolated
 * fixtures (tests, embedded scenarios) can pass a custom `stateDir`.
 */
export function resolveSessionStorePathForStateDir(stateDir?: string): string {
	const dir = stateDir ?? resolveStateDir();
	return path.join(dir, "brigade-store.json");
}

export async function saveSessionStore(
	storePath: string,
	store: Record<string, SessionEntry>,
): Promise<void> {
	await withSessionStoreLock(storePath, async () => {
		await saveSessionStoreUnlocked(storePath, store);
	});
}

/**
 * Read-modify-write under the per-storePath lock.
 *
 * The mutator receives a fresh load from disk on every invocation (no
 * cache between callers) so concurrent writers cannot clobber each
 * other's reads. The mutator's return value is what `updateSessionStore`
 * resolves to.
 */
export async function updateSessionStore<T>(
	storePath: string,
	mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
	return await withSessionStoreLock(storePath, async () => {
		const store = loadSessionStoreUnlocked(storePath);
		const result = await mutator(store);
		await saveSessionStoreUnlocked(storePath, store);
		return result;
	});
}

/**
 * Targeted single-entry update.
 *
 * Looks up the entry by session key (with legacy-key folding), invokes
 * the callback with the existing entry, then writes the patched copy
 * back. Returns the post-update entry, or `null` if the entry didn't
 * exist (the mutator is NOT called in the missing case).
 */
export async function updateSessionStoreEntry(params: {
	storePath: string;
	sessionKey: string;
	update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<SessionEntry | null> {
	const { storePath, sessionKey, update } = params;
	return await withSessionStoreLock(storePath, async () => {
		const store = loadSessionStoreUnlocked(storePath);
		const resolved = resolveSessionStoreEntry({ store, sessionKey });
		const existing = resolved.existing;
		if (!existing) return null;
		const patch = await update(existing);
		if (!patch) return existing;
		const next: SessionEntry = { ...existing, ...patch, updatedAt: Date.now() };
		store[resolved.normalizedKey] = next;
		for (const legacyKey of resolved.legacyKeys) {
			if (legacyKey === resolved.normalizedKey) continue;
			delete store[legacyKey];
		}
		await saveSessionStoreUnlocked(storePath, store);
		return next;
	});
}

/**
 * Sync loader exposed for callers that want a snapshot without entering
 * the lock (e.g. read-only views in CLI commands). Always reads the file
 * fresh; no in-process cache.
 */
export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
	return loadSessionStoreUnlocked(storePath);
}
