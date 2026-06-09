// src/storage/config-cache.ts
//
// In-process config cache for convex mode. Pi SDK boot paths and the per-turn
// loop read config SYNCHRONOUSLY (readConfigOrInit), which a network-backed
// store cannot serve directly. In convex mode the boot sequence primes this
// cache from `store.config.read()`; long-lived processes (the gateway) also
// subscribe to the config live-query and re-prime on every server-side change.
//
// The cache holds the RAW form — `${VAR}` secret references intact, exactly
// as the bytes sit in the brigadeConfig row. `readConfigOrInit`'s convex
// branch clones it and resolves secrets per call, mirroring the disk path's
// read-parse-resolve sequence byte-for-semantically.
//
// Filesystem mode never touches this module.

import type { BrigadeConfig } from "../config/types.js";

let _raw: BrigadeConfig | undefined;

/** Install/replace the cached raw config. Deep-clones so later caller
 *  mutations can't corrupt the cache. */
export function primeConfigCache(cfg: BrigadeConfig): void {
	_raw = structuredClone(cfg);
}

/** The cached raw (secret-refs-intact) config, or undefined when boot has
 *  not primed it. Callers MUST clone before mutating or resolving. */
export function getCachedConfigRaw(): BrigadeConfig | undefined {
	return _raw;
}

export function isConfigCachePrimed(): boolean {
	return _raw !== undefined;
}

/** Test-only. */
export function __resetConfigCacheForTests(): void {
	_raw = undefined;
}
