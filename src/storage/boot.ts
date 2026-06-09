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
 *  storage (doctor, status) catch and continue. */
export async function bootRuntimeContext(): Promise<RuntimeContext> {
	const existing = tryGetRuntimeContext();
	if (existing) return existing;
	if (!_inflight) {
		_inflight = (async () => {
			const ctx = await createRuntimeContext();
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

/** Test-only — clear the in-flight slot alongside
 *  `__resetRuntimeContextForTests()`. */
export function __resetBootForTests(): void {
	_inflight = undefined;
}
