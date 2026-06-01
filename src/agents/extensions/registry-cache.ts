/**
 * Process-wide extension registry cache.
 *
 * Without this layer, `loadModules` runs on EVERY agent turn — re-registering
 * every bundled module (whatsapp, arxiv, brave, duckduckgo, exa, firecrawl,
 * github-search, hackernews, npm-search, ollama-search, perplexity, searxng,
 * tavily, wikipedia — 14 today and growing) at the start of every prompt.
 * Each module's `register()` runs synchronous bookkeeping plus optional
 * `requiresEnv` checks; in the WhatsApp case it also touches the channel
 * registry. Doing this fourteen times per "remind me in 2 minutes" turn is
 * pure overhead, AND it amplifies any single module's slowness into a per-
 * turn tax — a hung register() that lasts 8s holds up EVERY turn.
 *
 * The shape: cache the registry by a stable identity (the config object the
 * loader closed over). When the gateway boots, it primes the cache once.
 * Every subsequent `runSingleTurn` call reuses the cached registry.
 * Config changes — operator edits `brigade.json` mid-session — require a
 * gateway restart today (the brigade.json file isn't watched). When we add
 * config hot-reload later, we'll call `invalidateExtensionRegistryCache()`
 * from the watch handler and the next turn rebuilds.
 *
 * Safety properties:
 *
 *   - The registry is READ by every consumer (system prompt assembler,
 *     toolset registry, memory capability resolver). It's never MUTATED
 *     after `loadModules` returns. Reusing the same instance across turns
 *     is therefore safe — there's no per-turn state that would leak.
 *
 *   - Module register() is supposed to be idempotent in OC's design, but we
 *     deliberately DON'T re-run it — even if a module's register() were
 *     side-effecting (e.g. registers a global hook), we want it called
 *     once to avoid double-dispatch.
 */

import { loadModules, type LoadModulesArgs } from "./loader.js";
import type { BrigadeExtensionRegistry } from "./registry.js";

/** The single cached registry. Undefined until the first build. */
let cachedRegistry: BrigadeExtensionRegistry | undefined;
/** Outstanding build promise — coalesces concurrent first-callers. */
let inFlightLoad: Promise<BrigadeExtensionRegistry> | undefined;

/**
 * Return the cached extension registry, building it on the first call.
 * Subsequent calls return the same instance — `loadModules` is NOT re-run.
 *
 * Concurrency: if N callers race the first build, only ONE
 * `loadModules` actually runs. The others await its promise so the
 * gateway boot path + the first inbound turn (which can arrive
 * micro-seconds apart) don't double-register.
 */
export async function getOrLoadExtensionRegistry(
	args: LoadModulesArgs,
): Promise<BrigadeExtensionRegistry> {
	if (cachedRegistry) return cachedRegistry;
	if (inFlightLoad) return inFlightLoad;
	inFlightLoad = loadModules(args).then(
		(registry) => {
			cachedRegistry = registry;
			inFlightLoad = undefined;
			return registry;
		},
		(err) => {
			// Don't cache failures — the next caller should be free to retry
			// with possibly-different config. Clear the in-flight slot so
			// concurrent retries get fresh build attempts.
			inFlightLoad = undefined;
			throw err;
		},
	);
	return inFlightLoad;
}

/**
 * Drop the cached registry. The next `getOrLoadExtensionRegistry` call
 * rebuilds. Wired in by:
 *   - Tests that need a fresh registry per case.
 *   - Future config hot-reload — when `brigade.json` changes on disk, the
 *     watcher calls this so the next turn picks up the new extensions /
 *     allow-list / disabled set.
 */
export function invalidateExtensionRegistryCache(): void {
	cachedRegistry = undefined;
	inFlightLoad = undefined;
}

/** Diagnostic — `true` if a registry has been built and cached. */
export function isExtensionRegistryCached(): boolean {
	return cachedRegistry !== undefined;
}
