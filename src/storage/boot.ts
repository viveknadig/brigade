// src/storage/boot.ts
//
// Process-boot entry for the storage layer. Every Brigade process calls
// `bootRuntimeContext()` exactly once before any subsystem touches state;
// after that, subsystems reach storage via `getRuntimeContext().store`.
//
// Idempotent by design: the CLI preAction hook, the gateway server, and any
// future embedder can all call it — the first caller pays the resolution +
// `store.init()` cost, everyone else gets the already-frozen context. A
// failed boot clears the in-flight slot so a retry (e.g. convex backend came
// back up) can succeed instead of replaying a cached rejection.

import { primeConfigCache } from "./config-cache.js";
import {
	createRuntimeContext,
	setRuntimeContext,
	tryGetRuntimeContext,
	type RuntimeContext,
} from "./runtime-context.js";

let _inflight: Promise<RuntimeContext> | undefined;

/** Resolve mode, build + init the store, and install the process-wide
 *  RuntimeContext. Safe to call from multiple places — only the first call
 *  does work. Throws when the backing store cannot initialise (e.g. convex
 *  mode with an unreachable deployment); callers that can operate without
 *  storage (doctor, status) catch and continue.
 *
 *  Convex mode additionally hydrates the in-process config cache so the
 *  codebase's synchronous `readConfigOrInit()` callers (per-turn loop, Pi
 *  boot paths) are served without touching disk. Long-lived processes call
 *  `enableConfigLiveRefresh()` afterwards to keep the cache hot. */
export async function bootRuntimeContext(): Promise<RuntimeContext> {
	const existing = tryGetRuntimeContext();
	if (existing) return existing;
	if (!_inflight) {
		_inflight = (async () => {
			const ctx = await createRuntimeContext();
			if (ctx.mode === "convex") {
				const { value } = await ctx.store.config.read();
				// First-boot parity with the disk path: an absent row reads as
				// `{}`; the disk path's absent-file shape is `{ agents: {} }`.
				const cfg =
					Object.keys(value as Record<string, unknown>).length === 0
						? ({ agents: {} } as typeof value)
						: value;
				primeConfigCache(cfg);
			}
			setRuntimeContext(ctx);
			return ctx;
		})();
		_inflight.catch(() => {
			// Allow a later retry after a transient failure. Without this, the
			// first rejection would be cached for the life of the process.
			_inflight = undefined;
		});
	}
	return _inflight;
}

let _configLiveUnsub: (() => void) | undefined;

/** Convex mode, long-lived processes only (the gateway): subscribe to the
 *  config live-query and re-prime the cache on every server-side change —
 *  the convex-mode equivalent of the filesystem hot-reload watcher. NOT
 *  called by short-lived CLI commands: the reactive WebSocket client would
 *  hold the process open. Idempotent; pair with
 *  `disableConfigLiveRefresh()` on shutdown. No-op in filesystem mode,
 *  where the existing fs.watch hot-reload already covers this. */
export function enableConfigLiveRefresh(): void {
	const ctx = tryGetRuntimeContext();
	if (!ctx || ctx.mode !== "convex") return;
	if (_configLiveUnsub) return; // already live
	_configLiveUnsub = ctx.store.config.subscribe((cfg) => {
		primeConfigCache(cfg);
	});
}

export function disableConfigLiveRefresh(): void {
	try {
		_configLiveUnsub?.();
	} finally {
		_configLiveUnsub = undefined;
	}
}

/** Test-only — clear the in-flight slot alongside
 *  `__resetRuntimeContextForTests()`. */
export function __resetBootForTests(): void {
	_inflight = undefined;
}
