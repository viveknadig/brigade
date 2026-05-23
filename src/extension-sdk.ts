/**
 * `brigade/extension-sdk` — the stable surface for authoring Brigade extensions.
 *
 * Out-of-tree modules dropped into `~/.brigade/extensions/` import from HERE,
 * never from Brigade internals:
 *
 * ```ts
 * import { defineModule } from "brigade/extension-sdk";
 *
 * export default defineModule({
 *   id: "my-channel",
 *   register(b) {
 *     b.channel(myAdapter);          // product-level (gateway)
 *     b.tool(myTool);                // agent-level (replayed into Pi)
 *     b.gatewayMethod({ name: "my.status", handler: async () => ({ ok: true }) });
 *   },
 * });
 * ```
 *
 * Everything re-exported here is part of Brigade's public extension contract and
 * is versioned with the package — module authors can rely on it not shifting
 * underneath them. (Internal wiring — the registry, loader, discovery — is NOT
 * exported; authors never touch it.)
 */

export { defineModule } from "./agents/extensions/types.js";
export type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./agents/tools/types.js";
export type {
	// Core context + module shape
	BrigadeExtensionContext,
	BrigadeModule,
	BrigadeModuleManifest,
	// Channels
	ChannelAdapter,
	ChannelCommand,
	ChannelCommandContext,
	ChannelPairingAdapter,
	ChannelSetupAdapter,
	ChannelSetupCredentialKey,
	ChannelStartContext,
	InboundMediaAttachment,
	InboundMessage,
	InboundReplyContext,
	OutboundMedia,
	OutboundSendOptions,
	// Voice / media / integrations
	Integration,
	MediaGenProvider,
	SpeechProvider,
	TranscriptionProvider,
	// Web tools (search + fetch providers)
	WebFetchProvider,
	WebProviderContext,
	WebProviderToolDefinition,
	WebSearchProvider,
	// Memory plugin SDK
	MemoryCapability,
	MemoryEmbeddingProvider,
	// Context engine / compaction / harness
	AgentHarness,
	CompactionProvider,
	ContextEngineCapability,
	// Hook system contracts
	HookExecutionPattern,
	HookResult,
	// Provider auth (model providers — registered via b.modelProvider)
	ProviderAuthMethod,
	// Gateway extensibility
	GatewayCaller,
	GatewayMethodHandler,
	HttpRoute,
	HttpRouteHandler,
	Service,
	ServiceStartContext,
} from "./agents/extensions/types.js";
