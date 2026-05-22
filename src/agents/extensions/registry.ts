/**
 * Brigade extension registry — the recorder + dispatcher behind the seam.
 *
 * A module registers through the `BrigadeExtensionContext` this produces; every
 * call is RECORDED here (not run live), because Brigade's gateway is per-turn:
 *   - agent-level registrations (tools/hooks/commands/model-providers) are replayed
 *     into EVERY Pi session via `toPiExtensionFactory()` (handed to
 *     `DefaultResourceLoader({ extensionFactories })`);
 *   - product-level registrations (channels/voice/media/integrations) are exposed
 *     to the gateway, which starts them ONCE at boot.
 *
 * Product registrations dedupe by id (last wins) so re-running modules is safe.
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import type {
	BrigadeExtensionContext,
	ChannelAdapter,
	CommandRegistration,
	HookRegistration,
	Integration,
	MediaGenProvider,
	ModelProviderRegistration,
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
}

export class BrigadeExtensionRegistry {
	private readonly toolRegs: ToolRegistration[] = [];
	private readonly hookRegs: HookRegistration[] = [];
	private readonly commandRegs: CommandRegistration[] = [];
	private readonly modelProviderRegs: ModelProviderRegistration[] = [];
	private readonly channelMap = new Map<string, ChannelAdapter>();
	private readonly speechMap = new Map<string, SpeechProvider>();
	private readonly transcriptionMap = new Map<string, TranscriptionProvider>();
	private readonly mediaGenMap = new Map<string, MediaGenProvider>();
	private readonly integrationMap = new Map<string, Integration>();

	/** Build the recording context a module's `register(b)` writes into. */
	context(meta: RegistryContextMeta): BrigadeExtensionContext {
		return {
			agentId: meta.agentId,
			workspaceDir: meta.workspaceDir,
			cwd: meta.cwd,
			config: meta.config,
			// agent-level → recorded, replayed into each Pi session
			tool: (tool, opts) => {
				this.toolRegs.push({ tool, toolset: opts?.toolset, eligible: opts?.eligible });
			},
			hook: (event, handler) => {
				this.hookRegs.push({ event, handler });
			},
			command: (name, options) => {
				this.commandRegs.push({ name, options });
			},
			modelProvider: (name, config) => {
				this.modelProviderRegs.push({ name, config });
			},
			// product-level → gateway-level registries (dedupe by id, last wins)
			channel: (adapter) => {
				this.channelMap.set(adapter.id, adapter);
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
			integration: (integration) => {
				this.integrationMap.set(integration.id, integration);
			},
		};
	}

	/* ── product-level getters (the gateway consumes these) ── */
	get channels(): ChannelAdapter[] {
		return [...this.channelMap.values()];
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
	get integrations(): Integration[] {
		return [...this.integrationMap.values()];
	}

	/* ── agent-level ── */

	/** Eligible tool objects (passes the per-tool `check_fn` gate). */
	eligibleTools(): AnyBrigadeTool[] {
		return this.toolRegs.filter((t) => !t.eligible || t.eligible()).map((t) => t.tool);
	}

	/** Names of eligible tools — feed into `enabledToolNames` so the unknown-tool guard allows them. */
	toolNames(): string[] {
		return this.eligibleTools().map((t) => t.name);
	}

	/**
	 * Replay the recorded agent-level registrations into a Pi session. Hand the
	 * result to `new DefaultResourceLoader({ extensionFactories: [factory] })`
	 * (and remember to `await loader.reload()` — Brigade passes the loader in, so
	 * `createAgentSession` won't reload it itself).
	 */
	toPiExtensionFactory(): ExtensionFactory {
		return (pi: ExtensionAPI) => {
			for (const t of this.toolRegs) {
				if (t.eligible && !t.eligible()) continue;
				// AgentTool → Pi ToolDefinition: structurally compatible (Brigade's
				// 4-arg execute is assignable to the 5-arg ToolDefinition.execute; the
				// optional ToolDefinition fields are simply absent). Cast bridges the
				// nominal gap without changing tool authoring.
				pi.registerTool(t.tool as never);
			}
			for (const h of this.hookRegs) {
				pi.on(h.event as never, h.handler as never);
			}
			for (const c of this.commandRegs) {
				pi.registerCommand(c.name, c.options as never);
			}
			// Model-provider registration is forward-compat (no providers ship as
			// modules yet); guard at runtime so a Pi API rename can't break the build.
			const registerProvider = (pi as unknown as { registerProvider?: (n: string, c: unknown) => void })
				.registerProvider;
			if (typeof registerProvider === "function") {
				for (const p of this.modelProviderRegs) registerProvider.call(pi, p.name, p.config);
			}
		};
	}
}
