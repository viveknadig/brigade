/**
 * In-process `GatewayCaller` implementation (Step 25).
 *
 * Fills the hole Step 18 left in `gateway-call.ts`. Brigade today runs
 * the gateway and the agent runtime in the SAME process — the WebSocket
 * server is a thin wrapper around the same handler functions. This file
 * provides the in-process caller that tool layers (Steps 19-23) and
 * sub-agent spawn (Step 20) dispatch through.
 *
 * The mapping is straightforward: every gateway method has a handler
 * function registered via `registerHandler(method, handler)`. The caller's
 * `call({ method, params })` looks up the handler and invokes it directly,
 * skipping the WebSocket transport entirely.
 *
 * Out-of-process callers (web UI, mobile app, remote `brigade connect`)
 * will go through the actual WebSocket server when Brigade ships its v2
 * gateway. The contract is the same — same method names, same params +
 * result shapes (see `protocol/methods.ts`) — only the transport changes.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
	setGlobalGatewayCaller,
	type GatewayCaller,
	type GatewayCallOptions,
} from "../agents/gateway-call.js";

const log = createSubsystemLogger("core/gateway-caller-impl");

export type GatewayHandler<P = unknown, R = unknown> = (params: P) => Promise<R> | R;

type HandlerRegistry = Map<string, GatewayHandler>;

const HANDLER_REGISTRY_KEY = Symbol.for("brigade.gatewayCallerImpl.handlers");

function getRegistry(): HandlerRegistry {
	return resolveGlobalSingleton<HandlerRegistry>(HANDLER_REGISTRY_KEY, () => new Map());
}

/**
 * Register a handler for a gateway method. Replacing an existing handler
 * logs a warning — Brigade boot should register each method exactly once.
 */
export function registerGatewayHandler<P = unknown, R = unknown>(
	method: string,
	handler: GatewayHandler<P, R>,
): () => void {
	const registry = getRegistry();
	if (registry.has(method)) {
		log.warn("replacing existing gateway handler", { method });
	}
	registry.set(method, handler as GatewayHandler);
	return () => {
		if (registry.get(method) === handler) registry.delete(method);
	};
}

/** Enumerate every registered method (useful for `health` + tests). */
export function listRegisteredMethods(): string[] {
	return [...getRegistry().keys()].sort();
}

/**
 * Construct the in-process caller. Idempotent — calling twice returns
 * a fresh caller but they share the same handler registry (singleton).
 */
export function createInProcessGatewayCaller(): GatewayCaller {
	return {
		call: async <T = Record<string, unknown>>(opts: GatewayCallOptions): Promise<T> => {
			const registry = getRegistry();
			const handler = registry.get(opts.method);
			if (!handler) {
				throw new Error(`gateway method not registered: ${opts.method}`);
			}
			const params = opts.params ?? {};
			const timeoutMs = opts.timeoutMs;
			if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
				return await withTimeout(handler(params) as Promise<T>, timeoutMs, opts.method);
			}
			return (await handler(params)) as T;
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`gateway method ${method} timed out after ${ms}ms`));
		}, ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * Boot helper: install the in-process caller as the global dispatcher
 * so every `callGateway(...)` call resolves to a local handler. Returns
 * a disposer that unsets the caller.
 */
export function installInProcessGatewayCaller(): () => void {
	return setGlobalGatewayCaller(createInProcessGatewayCaller());
}

/** Test-only — wipe every registered handler. */
export function resetGatewayHandlersForTests(): void {
	getRegistry().clear();
}
