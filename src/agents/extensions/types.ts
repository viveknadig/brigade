/**
 * Brigade extension seam — the contracts every capability plugs into.
 *
 * Brigade's plugin layer = Pi 0.73's native extension engine (agent-level:
 * tools / hooks / commands / model providers) + thin Brigade "capability
 * registries" for the product surfaces Pi has no concept of (channels, voice,
 * media, integrations, memory backends). A single **module** registers across
 * both through one context (`BrigadeExtensionContext`); the loader records each
 * registration, replays the agent-level ones into every Pi session as an
 * `ExtensionFactory`, and hands the product-level ones to the gateway.
 *
 * THE NO-REWRITE GUARANTEE: every capability contract below is fixed HERE, once.
 * Adding ElevenLabs TTS, Whisper STT, a Slack channel, or a new API later means
 * writing a module that implements the contract + calls `b.tts(...)` / `b.channel(...)`
 * — existing code never changes. Implementations land per phase; the seam doesn't move.
 *
 * Provides a full plugin-API register surface, but realized as Pi extensions +
 * light capability registries instead of a bespoke engine.
 */

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";

/* ─────────────────────────── capability contracts ─────────────────────────── */
/* These are the LOCKED interfaces. Implementations arrive per phase; the shapes
 * are stable so nothing downstream is rewritten when a capability lands. */

/** A normalized inbound message from any channel (WhatsApp/Slack/Telegram/…). */
export interface InboundMessage {
	/** Channel id, e.g. "whatsapp". */
	channel: string;
	/** Stable conversation/chat id within the channel (the session-key seed). */
	conversationId: string;
	/** Sender id within the channel (phone/user id). */
	from: string;
	/** Plain text of the message. */
	text: string;
	/** Optional display name of the sender. */
	fromName?: string;
	/** Raw provider payload (for adapters that need more). */
	raw?: unknown;
}

/** Context handed to a channel adapter when the gateway starts it. */
export interface ChannelStartContext {
	/** Called by the adapter for every inbound message; Brigade runs a turn + replies. */
	onInbound: (msg: InboundMessage) => Promise<void>;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Abort signal — adapter must stop cleanly when this fires. */
	signal: AbortSignal;
	/** A place to surface a QR / pairing code to the operator (e.g. WhatsApp). */
	onPairing?: (info: { kind: "qr" | "code"; value: string }) => void;
}

/**
 * A messaging channel (Channels phase). WhatsApp is the first implementer; Slack/
 * Telegram/etc. implement the same shape. The gateway starts each configured
 * channel once, routes inbound → agent turn → `sendText` for the reply.
 */
export interface ChannelAdapter {
	id: string;
	label: string;
	/** Env vars / config the channel needs (gating). */
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Begin listening; call `ctx.onInbound` per message. Resolves once connected. */
	start(ctx: ChannelStartContext): Promise<void>;
	/** Stop listening + tear down. */
	stop(): Promise<void>;
	/** Send an outbound text reply to a conversation. */
	sendText(conversationId: string, text: string): Promise<void>;
}

/** Text-to-speech provider (Voice phase). e.g. ElevenLabs, OpenAI, Edge TTS. */
export interface SpeechProvider {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Synthesize speech; returns audio bytes + mime type. */
	synthesize(text: string, opts?: { voice?: string }): Promise<{ audio: Buffer; mimeType: string }>;
}

/** Speech-to-text provider (Voice phase). e.g. Whisper, Groq, Deepgram. */
export interface TranscriptionProvider {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	/** Transcribe audio bytes to text. */
	transcribe(audio: Buffer, opts?: { mimeType?: string }): Promise<{ text: string }>;
}

/** Media generation provider (Media phase). e.g. image/video/music gen. */
export interface MediaGenProvider {
	id: string;
	label: string;
	kind: "image" | "video" | "music";
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	generate(prompt: string, opts?: Record<string, unknown>): Promise<{ data: Buffer; mimeType: string }>;
}

/** A generic third-party API integration (any external service). */
export interface Integration {
	id: string;
	label: string;
	requiresEnv?: string[];
	isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
}

/* ─────────────────────────── the module context ─────────────────────────── */

/** A recorded model-provider registration (replayed into Pi via `pi.registerProvider`). */
export interface ModelProviderRegistration {
	name: string;
	config: unknown; // Pi's ProviderConfig (kept loose to avoid coupling the seam to Pi internals)
}

/** A recorded slash-command registration (replayed via `pi.registerCommand`). */
export interface CommandRegistration {
	name: string;
	options: unknown; // Pi's RegisteredCommand options
}

/** A recorded lifecycle-hook subscription (replayed via `pi.on(event, handler)`). */
export interface HookRegistration {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

/** A recorded tool registration + its enablement gate. */
export interface ToolRegistration {
	tool: AnyBrigadeTool;
	/** Toolset grouping (minimal/coding/messaging/full); informs profile gating. */
	toolset?: string;
	/** Eligibility gate (skills-style check_fn) — false → tool not offered this run. */
	eligible?: () => boolean;
}

/**
 * The single context a module registers through. Agent-level methods are RECORDED
 * and replayed into every Pi session; product-level methods register into Brigade's
 * gateway-level capability registries. (Recording — not live delegation — because
 * Brigade's gateway is per-turn: agent-level wiring re-applies each session, while
 * channels/services start once at gateway boot.)
 */
export interface BrigadeExtensionContext {
	/** Active agent id. */
	readonly agentId: string;
	/** Resolved workspace dir. */
	readonly workspaceDir: string;
	/** Process cwd. */
	readonly cwd: string;
	/** The active Brigade config (read-only to modules). */
	readonly config: BrigadeConfig;

	/* agent-level → replayed into Pi's ExtensionAPI per session */
	tool(tool: AnyBrigadeTool, opts?: { toolset?: string; eligible?: () => boolean }): void;
	/**
	 * Subscribe to a Pi lifecycle event (replayed via `pi.on`). NOTE: a
	 * `before_agent_start` handler may NOT replace the system prompt — Brigade
	 * pins the persona, so any `systemPrompt` returned from that event is
	 * stripped before Pi sees it (the rest of the result is kept).
	 */
	hook(event: string, handler: (...args: unknown[]) => unknown): void;
	command(name: string, options: unknown): void;
	modelProvider(name: string, config: unknown): void;

	/* product-level → Brigade capability registries (gateway-level) */
	channel(adapter: ChannelAdapter): void;
	tts(provider: SpeechProvider): void;
	stt(provider: TranscriptionProvider): void;
	mediaGen(provider: MediaGenProvider): void;
	integration(integration: Integration): void;
}

/**
 * A Brigade module — the unit of extension. One module may register any mix of
 * tools/hooks/commands/providers (agent-level) and channels/voice/media/integrations
 * (product-level). Discovered + loaded by the extension loader; gated by `eligible`
 * + config allow/deny + `requiresEnv`.
 */
export interface BrigadeModule {
	id: string;
	/** Env vars required for this module to load at all. */
	requiresEnv?: string[];
	/** Optional gate evaluated at load (os/bins/config, skills-style). */
	eligible?: (ctx: { config: BrigadeConfig; env: NodeJS.ProcessEnv }) => boolean;
	/** Register this module's capabilities. */
	register(b: BrigadeExtensionContext): void | Promise<void>;
}

/** Identity helper for authoring a module (mirrors Pi's `defineTool`). */
export function defineModule(module: BrigadeModule): BrigadeModule {
	return module;
}
