// src/agents/transport-dispatch.ts
//
// Direct dispatch for Brigade's OWN transports (claude-cli, native ollama),
// immune to duplicate `pi-ai` installs.
//
// WHY: Brigade registers its custom transports into pi-ai's module-global
// `apiProviderRegistry` (`registerApiProvider`), and Pi's Agent resolves them at
// dispatch via `streamSimple` → `resolveApiProvider(model.api)`. That works only
// when BOTH sides load the SAME `pi-ai` module instance.
//
// In a published/global install (`npm i -g @spinabot/brigade`) npm nests a second
// copy of `@earendil-works/pi-ai` under `pi-coding-agent` (which also carries its
// own `pi-agent-core`). Brigade imports `createAgentSession` from
// `pi-coding-agent`, so the Agent's `streamSimple` reads the NESTED pi-ai's
// registry — while `register.ts` wrote into the TOP-LEVEL one. Two directories =
// two ES module instances = two Maps, so the lookup misses and Pi throws
// `No API provider registered for api: claude-cli` (and the same for `ollama`)
// before the transport ever runs. The repo's `overrides` hoist a single copy for
// local dev, but npm only honours `overrides` from the ROOT project — a consumer
// installing the published package gets none of that protection. Hence: local
// green, global broken.
//
// FIX: don't depend on a registry we don't control the identity of. Route
// `api: "claude-cli" | "ollama"` straight to Brigade's stream fn. Everything else
// falls through to Pi's own streamFn — which MUST be preserved, because it
// carries Pi's auth wrapping (replacing it makes every cloud call silently
// keyless). Our transports need no credential (claude-cli uses the binary's own
// login; ollama is unauthenticated), so bypassing that wrapper is safe for them
// and only for them.
//
// `ensure*ApiRegistered()` calls elsewhere stay: they remain correct for any code
// path that still resolves through the registry, and are harmless here.

import { CLAUDE_CLI_API } from "./claude-cli/catalog.js";
import { createClaudeCliStreamFn } from "./claude-cli/stream.js";
import { OLLAMA_NATIVE_API } from "./ollama-native/register.js";
import { createOllamaStreamFn } from "./ollama-native/stream.js";
import type { BrigadeStreamFn } from "./stream-wrappers.js";

// Built once per process — the factories are pure and the fns are stateless.
let claudeCliStreamFn: BrigadeStreamFn | undefined;
let ollamaStreamFn: BrigadeStreamFn | undefined;

/**
 * The Brigade-owned transport for `api`, or undefined when Pi should handle it.
 * Exported for tests + for any other seam that creates its own Pi session.
 */
export function resolveBrigadeTransport(api: unknown): BrigadeStreamFn | undefined {
	if (api === CLAUDE_CLI_API) {
		claudeCliStreamFn ??= createClaudeCliStreamFn() as unknown as BrigadeStreamFn;
		return claudeCliStreamFn;
	}
	if (api === OLLAMA_NATIVE_API) {
		ollamaStreamFn ??= createOllamaStreamFn() as unknown as BrigadeStreamFn;
		return ollamaStreamFn;
	}
	return undefined;
}

/**
 * Wrap `base` (Pi's auth-aware streamFn) so a Brigade-owned `model.api` is
 * dispatched directly and everything else falls through unchanged. Install this
 * as the INNERMOST layer, beneath Brigade's stream wrappers, so idle-timeout /
 * stop-reason / tool-call-repair still apply to custom transports too.
 */
export function makeTransportDispatch<F extends BrigadeStreamFn>(base: F): F {
	const dispatch = (...args: unknown[]): unknown => {
		const model = args[0] as { api?: unknown } | undefined;
		const custom = resolveBrigadeTransport(model?.api);
		return (custom ?? base)(...args);
	};
	return dispatch as F;
}

/**
 * Install the dispatch on a Pi session that builds its OWN agent (the isolated
 * memory/skill distiller sessions in `makeIsolatedLlm`). They never pass through
 * the agent-loop's wrapper, so without this a claude-cli / ollama distiller hits
 * the same missing-registry throw. WRAPS the existing streamFn — never replaces
 * it — so Pi's auth wrapper stays beneath for cloud providers.
 */
export function installTransportDispatch(session: unknown): void {
	const agent = (session as { agent?: { streamFn?: BrigadeStreamFn } } | undefined)?.agent;
	if (!agent || typeof agent.streamFn !== "function") return;
	agent.streamFn = makeTransportDispatch(agent.streamFn);
}

/** Test seam — drop the memoized transports so a test can re-derive them. */
export function __resetTransportDispatchCache(): void {
	claudeCliStreamFn = undefined;
	ollamaStreamFn = undefined;
}

/**
 * Test seam — pre-seed the memoized transport for `api`.
 *
 * A dispatch test must observe ROUTING, not run the transport: invoking the real
 * claude-cli one spawns the `claude` binary and writes to its stdin, and a test that
 * abandons that child leaves the pipe to die after the test ends — which Node raises
 * as an uncaught `write EPIPE`. Green locally, and it failed an npm publish in CI.
 */
export function __setBrigadeTransportForTests(api: unknown, fn: BrigadeStreamFn | undefined): void {
	if (api === CLAUDE_CLI_API) claudeCliStreamFn = fn;
	else if (api === OLLAMA_NATIVE_API) ollamaStreamFn = fn;
}
