/**
 * Brigade extension registry — the recorder + dispatcher behind the seam.
 *
 * A module registers through the `BrigadeExtensionContext` this produces; every
 * call is RECORDED here (not run live), because Brigade's gateway is per-turn:
 *   - agent-level registrations (tools/hooks/commands/model-providers) are replayed
 *     into EVERY Pi session via `toPiExtensionFactory()` (handed to
 *     `DefaultResourceLoader({ extensionFactories })`);
 *   - product-level registrations (channels/voice/media/integrations/services/
 *     http-routes/gateway-methods) are exposed to the gateway, which starts /
 *     mounts them ONCE at boot.
 *
 * Product registrations dedupe by id (last wins) so re-running modules is safe.
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import { type BrigadeHookName, createHookRunner, type HookFireResult } from "./hook-runner.js";
import type {
	BrigadeExtensionContext,
	ChannelAdapter,
	ChannelCommand,
	CommandRegistration,
	GatewayMethodHandler,
	HookRegistration,
	HttpRoute,
	Integration,
	MediaGenProvider,
	ModelProviderRegistration,
	ProviderAuthMethodRegistration,
	Service,
	SpeechProvider,
	ToolRegistration,
	TranscriptionProvider,
} from "./types.js";

/** Per-load context Brigade supplies to each module's `register(b)`. */
export interface RegistryContextMeta {
	agentId: string;
	workspaceDir: string;
	cwd: string;
	config: BrigadeConfig;
	/** This module's validated config block (see `BrigadeExtensionContext.moduleConfig`). */
	moduleConfig?: unknown;
}

export class BrigadeExtensionRegistry {
	private readonly toolRegs: ToolRegistration[] = [];
	private readonly hookRegs: HookRegistration[] = [];
	private readonly commandRegs: CommandRegistration[] = [];
	private readonly modelProviderRegs: ModelProviderRegistration[] = [];
	private readonly providerAuthMethodRegs: ProviderAuthMethodRegistration[] = [];
	private readonly channelMap = new Map<string, ChannelAdapter>();
	private readonly channelCommandMap = new Map<string, ChannelCommand>();
	private readonly speechMap = new Map<string, SpeechProvider>();
	private readonly transcriptionMap = new Map<string, TranscriptionProvider>();
	private readonly mediaGenMap = new Map<string, MediaGenProvider>();
	private readonly memoryMap = new Map<string, import("./types.js").MemoryCapability>();
	private readonly memoryEmbeddingMap = new Map<string, import("./types.js").MemoryEmbeddingProvider>();
	private readonly contextEngineMap = new Map<string, import("./types.js").ContextEngineCapability>();
	private readonly compactionProviderMap = new Map<string, import("./types.js").CompactionProvider>();
	private readonly agentHarnessMap = new Map<string, import("./types.js").AgentHarness>();
	private readonly integrationMap = new Map<string, Integration>();
	private readonly serviceMap = new Map<string, Service>();
	private readonly httpRouteMap = new Map<string, HttpRoute>();
	private readonly gatewayMethodMap = new Map<string, GatewayMethodHandler>();

	/** Modules that successfully registered — the loader fills this (used for reload). */
	readonly loadedModules: import("./types.js").BrigadeModule[] = [];

	/** Build the recording context a module's `register(b)` writes into. */
	context(meta: RegistryContextMeta): BrigadeExtensionContext {
		return {
			agentId: meta.agentId,
			workspaceDir: meta.workspaceDir,
			cwd: meta.cwd,
			config: meta.config,
			moduleConfig: meta.moduleConfig,
			// agent-level → recorded, replayed into each Pi session
			tool: (tool, opts) => {
				this.toolRegs.push({ tool, toolset: opts?.toolset, eligible: opts?.eligible });
			},
			hook: (event, handler, opts) => {
				this.hookRegs.push({ event, handler, priority: opts?.priority });
			},
			command: (name, options) => {
				this.commandRegs.push({ name, options });
			},
			modelProvider: (name, config) => {
				this.modelProviderRegs.push({ name, config });
			},
			providerAuthMethod: (providerName, method) => {
				this.providerAuthMethodRegs.push({ providerName, method });
			},
			// product-level → gateway-level registries (dedupe by id, last wins)
			channel: (adapter) => {
				this.channelMap.set(adapter.id, adapter);
			},
			channelCommand: (command) => {
				// Lowercase the key so dedup here agrees with the manager's
				// case-insensitive dispatch (both sides use lowercase).
				this.channelCommandMap.set(command.name.toLowerCase(), command);
			},
			tts: (provider) => {
				this.speechMap.set(provider.id, provider);
			},
			stt: (provider) => {
				this.transcriptionMap.set(provider.id, provider);
			},
			mediaGen: (provider) => {
				this.mediaGenMap.set(provider.id, provider);
			},
			memory: (capability) => {
				this.memoryMap.set(capability.id, capability);
			},
			memoryEmbeddingProvider: (provider) => {
				this.memoryEmbeddingMap.set(provider.id, provider);
			},
			contextEngine: (engine) => {
				this.contextEngineMap.set(engine.id, engine);
			},
			compactionProvider: (provider) => {
				this.compactionProviderMap.set(provider.id, provider);
			},
			agentHarness: (harness) => {
				this.agentHarnessMap.set(harness.id, harness);
			},
			integration: (integration) => {
				this.integrationMap.set(integration.id, integration);
			},
			service: (service) => {
				this.serviceMap.set(service.id, service);
			},
			httpRoute: (route) => {
				// Dedupe by method+path (last wins) so two modules can't both bind
				// the same route with one silently dead.
				this.httpRouteMap.set(`${route.method ?? "ANY"} ${route.path}`, route);
			},
			gatewayMethod: (method) => {
				this.gatewayMethodMap.set(method.name, method);
			},
		};
	}

	/* ── product-level getters (the gateway consumes these) ── */
	get channels(): ChannelAdapter[] {
		return [...this.channelMap.values()];
	}
	get channelCommands(): ChannelCommand[] {
		return [...this.channelCommandMap.values()];
	}
	get speechProviders(): SpeechProvider[] {
		return [...this.speechMap.values()];
	}
	get transcriptionProviders(): TranscriptionProvider[] {
		return [...this.transcriptionMap.values()];
	}
	get mediaGenProviders(): MediaGenProvider[] {
		return [...this.mediaGenMap.values()];
	}
	get memoryCapabilities(): import("./types.js").MemoryCapability[] {
		return [...this.memoryMap.values()];
	}
	get memoryEmbeddingProviders(): import("./types.js").MemoryEmbeddingProvider[] {
		return [...this.memoryEmbeddingMap.values()];
	}
	get contextEngines(): import("./types.js").ContextEngineCapability[] {
		return [...this.contextEngineMap.values()];
	}
	get compactionProviders(): import("./types.js").CompactionProvider[] {
		return [...this.compactionProviderMap.values()];
	}
	get agentHarnesses(): import("./types.js").AgentHarness[] {
		return [...this.agentHarnessMap.values()];
	}

	/**
	 * Resolve the active slot-selected capability for a given slot key.
	 * `extensions.slots.<slot>` in `brigade.json` names the active plugin id;
	 * when unset, returns `undefined` (Brigade's built-in path takes over).
	 *
	 *   const memory = registry.resolveSlot("memory", cfg, registry.memoryCapabilities);
	 *
	 * Generic so any slot uses the same lookup shape.
	 */
	resolveSlot<T extends { id: string }>(
		slotName: "memory" | "contextEngine" | "compaction" | "agentHarness",
		cfg: BrigadeConfig,
		candidates: ReadonlyArray<T>,
	): T | undefined {
		const slots = (cfg as { extensions?: { slots?: Record<string, string> } }).extensions?.slots;
		const pinnedId = slots?.[slotName]?.trim();
		if (!pinnedId) return undefined;
		return candidates.find((c) => c.id === pinnedId);
	}

	get integrations(): Integration[] {
		return [...this.integrationMap.values()];
	}
	get services(): Service[] {
		return [...this.serviceMap.values()];
	}
	get httpRoutes(): HttpRoute[] {
		return [...this.httpRouteMap.values()];
	}
	get gatewayMethods(): GatewayMethodHandler[] {
		return [...this.gatewayMethodMap.values()];
	}

	/**
	 * Recorded provider auth methods, optionally filtered to a single provider.
	 * Order = registration order — that's the order onboarding/resolution should
	 * try methods in (first viable wins). Today this is shape-only — the
	 * consumer-side resolver lands when the first OAuth provider plugin ships.
	 */
	providerAuthMethods(providerName?: string): ProviderAuthMethodRegistration[] {
		if (!providerName) return [...this.providerAuthMethodRegs];
		return this.providerAuthMethodRegs.filter((r) => r.providerName === providerName);
	}

	/* ── agent-level ── */

	/**
	 * Eligible tool objects (passes the per-tool `check_fn` gate).
	 *
	 * When `opts.toolset` is supplied (e.g. `"minimal" | "coding" | "messaging"
	 * | "full"`), the result is additionally filtered to tools whose recorded
	 * `toolset` either matches that string, is `"*"` (universal opt-in), or is
	 * `undefined` (no profile declared — always included so legacy / un-tagged
	 * tools never disappear behind a profile switch). Unset / empty `toolset`
	 * disables the filter — the tool list returns as if the knob weren't there
	 * (full surface), which is the desired default for `agents.defaults.toolset`
	 * being absent from `brigade.json`.
	 */
	eligibleTools(opts: { toolset?: string } = {}): AnyBrigadeTool[] {
		const profile = opts.toolset?.trim();
		const profileActive = profile !== undefined && profile.length > 0 && profile !== "full";
		return this.toolRegs
			.filter((t) => !t.eligible || t.eligible())
			.filter((t) => {
				if (!profileActive) return true;
				if (t.toolset === undefined) return true;
				if (t.toolset === "*") return true;
				return t.toolset === profile;
			})
			.map((t) => t.tool);
	}

	/** Names of eligible tools — feed into `enabledToolNames` so the unknown-tool guard allows them. */
	toolNames(opts: { toolset?: string } = {}): string[] {
		return this.eligibleTools(opts).map((t) => t.name);
	}

	/**
	 * Fire a Brigade-native hook event through the 4-pattern runner. The pattern
	 * is looked up by name from `HOOK_PATTERNS` (telemetry/modifying/claiming/
	 * sync) — callers pass the payload and get back the merged outcome.
	 *
	 *   const claim = await registry.fireHook("inbound_claim", { channel, msg });
	 *   if (claim.handled) return; // a plugin owns this inbound
	 *
	 * Returns `{ handlerCount }` plus pattern-specific fields:
	 *   - claiming → `{ handled, by? }` (handler index 0-based that claimed)
	 *   - modifying → `{ modifications }` (merged payload patch)
	 *   - void / sync → just the count
	 */
	async fireHook<T = unknown>(name: BrigadeHookName, payload: T): Promise<HookFireResult> {
		const matching = this.hookRegs.filter((h) => h.event === name);
		const runner = createHookRunner(
			matching.map((h) => ({
				handler: h.handler as (p: unknown) => unknown,
				priority: h.priority,
			})),
		);
		return runner.fire(name, payload);
	}

	/** Recorded hooks sorted by priority (higher first); ties keep registration order. */
	private sortedHooks(): HookRegistration[] {
		// Stable sort: decorate with index so equal priorities preserve insertion order.
		return this.hookRegs
			.map((h, i) => ({ h, i }))
			.sort((a, b) => (b.h.priority ?? 0) - (a.h.priority ?? 0) || a.i - b.i)
			.map((x) => x.h);
	}

	/**
	 * Replay the recorded agent-level registrations into a Pi session. Hand the
	 * result to `new DefaultResourceLoader({ extensionFactories: [factory] })`
	 * (and remember to `await loader.reload()` — Brigade passes the loader in, so
	 * `createAgentSession` won't reload it itself).
	 *
	 * `opts.toolset` mirrors `eligibleTools()` — when supplied, tools whose
	 * `toolset` doesn't match (and isn't `"*"` / unset) are NOT registered into
	 * Pi. The same value must be threaded into both `toolNames(opts)` (for the
	 * unknown-tool guard's allowlist) and the factory so the two views agree.
	 */
	toPiExtensionFactory(opts: { toolset?: string } = {}): ExtensionFactory {
		const profile = opts.toolset?.trim();
		const profileActive = profile !== undefined && profile.length > 0 && profile !== "full";
		return (pi: ExtensionAPI) => {
			for (const t of this.toolRegs) {
				if (t.eligible && !t.eligible()) continue;
				if (profileActive) {
					if (t.toolset !== undefined && t.toolset !== "*" && t.toolset !== profile) continue;
				}
				// AgentTool → Pi ToolDefinition: Pi's tool wrapper invokes execute with
				// `ctx` as a trailing positional arg, which Brigade's 4-arg execute
				// simply ignores; the required fields (name/label/description/parameters)
				// all match. Cast bridges the nominal gap without changing authoring.
				pi.registerTool(t.tool as never);
			}
			// Pi has no native hook priority — handlers fire in registration order — so
			// we replay in Brigade's priority order (higher first).
			for (const h of this.sortedHooks()) {
				if (h.event === "before_agent_start") {
					// Brigade PINS the persona (it overwrites Pi's _baseSystemPrompt).
					// Pi lets a `before_agent_start` handler replace the system prompt
					// for the turn, which would silently clobber that pin — so we strip
					// any `systemPrompt` a module returns while preserving the rest of
					// the result (e.g. an injected `message`).
					const inner = h.handler;
					const guarded = async (...a: unknown[]): Promise<unknown> => {
						const res = await inner(...a);
						if (res && typeof res === "object" && "systemPrompt" in (res as Record<string, unknown>)) {
							const { systemPrompt: _dropped, ...rest } = res as Record<string, unknown>;
							return rest;
						}
						return res;
					};
					pi.on(h.event as never, guarded as never);
				} else {
					pi.on(h.event as never, h.handler as never);
				}
			}
			for (const c of this.commandRegs) {
				pi.registerCommand(c.name, c.options as never);
			}
			// Model-provider registration: guard at runtime so a Pi API rename can't
			// break the build (no providers ship as modules yet).
			const registerProvider = (pi as unknown as { registerProvider?: (n: string, c: unknown) => void })
				.registerProvider;
			if (typeof registerProvider === "function") {
				for (const p of this.modelProviderRegs) registerProvider.call(pi, p.name, p.config);
			}
		};
	}
}
