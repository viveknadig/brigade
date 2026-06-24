/**
 * Discord channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the discord.js
 * Gateway + REST connection. Like Slack, Discord is TOKEN-based: the operator
 * pastes a bot token from the Discord Developer Portal, so this adapter declares
 * a `setup` wizard (one credential) and has NO QR/link flow. Enablement is
 * explicit — `channels.discord.enabled: true` plus a resolvable bot token.
 *
 * Modeled directly on `slack/adapter.ts`: same health-flag mirroring, same
 * deferred-media passthrough on inbound, same chunk-then-send outbound shape
 * (chunk markdown ≤2000, convert each chunk to Discord markup, send). Discord
 * markup never "fails to parse" the way Telegram HTML can, so the outbound path
 * is simple — an empty rendered chunk falls back to the raw chunk.
 *
 * Capabilities: edit (message.edit), unsend (message.delete), reactions
 * (message.react), reply (reply reference + threads), threads, media
 * (AttachmentBuilder), buttons (ActionRow + Button), and NATIVE slash commands
 * (registered via REST application commands on connect). Unlike Slack, Discord's
 * command menu IS pushed programmatically — `nativeCommands: true`.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
// Channel SDK barrel — the single import surface for the channel-authoring
// contract + shared helpers. Contract types + `chunkText` + `buildBundledCommands`
// come from one place instead of scattered paths.
import {
	buildBundledCommands,
	chunkText,
	type ChannelAdapter,
	type ChannelApprovalPromptParams,
	type ChannelCapabilities,
	type ChannelHealth,
	type ChannelMessageAction,
	type ChannelMessageActionResult,
	type ChannelReplyStream,
	type ChannelStartContext,
	type OutboundMedia,
	type OutboundSendOptions,
} from "../sdk.js";
import { readAllowFrom } from "../access-control/store.js";
import {
	discordChannelEnabled,
	discordLiveStreamEnabled,
	discordReactionNotifications,
	discordStreamThrottleMs,
	discordSurfaceReasoning,
	listDiscordAccountIds,
	resolveDiscordAutoThread,
	resolveDiscordBotToken,
	resolveDiscordPresence,
	resolveDiscordProxyUrl,
	DISCORD_CHANNEL_ID,
	DISCORD_DEFAULT_ACCOUNT_ID,
	type ResolvedDiscordPresence,
} from "./account-config.js";
import { resolveDiscordApprover } from "./approval-authorize.js";
import { buildDiscordApprovalMessage } from "./approval-native.js";
import { buildDiscordButtonRows } from "./components.js";
import { buildDiscordCommandManifest } from "./command-menu.js";
import {
	connectDiscord,
	sanitizeThreadName,
	type ConnectDiscordArgs,
	type DiscordConnection,
	type DiscordInboundMessage,
	type DiscordPresencePayload,
} from "./connection.js";
import { resolveDiscordHandle } from "./directory-cache.js";
import { createDraftStream } from "./draft-stream.js";
import { discordTextIsEmpty, markdownToDiscord, rewriteKnownMentions } from "./format.js";
import { splitDiscordReasoning } from "./reasoning-lane.js";

/** Discord's per-message text limit (chars) for chunked sends. */
const DISCORD_TEXT_LIMIT = 2_000;

/**
 * Map a resolved presence config into the discord.js `PresenceData` payload the
 * connection applies on (re)connect (Phase 5). A `custom` activity (type 4)
 * carries its text in the `state` field (Discord renders custom status from the
 * state); every other type uses `name`. A `streaming` activity (type 1) adds the
 * `url`. Returns `null` when no presence is configured.
 */
export function mapDiscordPresencePayload(presence: ResolvedDiscordPresence | null): DiscordPresencePayload | null {
	if (!presence) return null;
	const payload: DiscordPresencePayload = { status: presence.status };
	if (presence.activityTypeCode !== undefined) {
		const isCustom = presence.activityTypeCode === 4;
		const text = presence.activityText ?? "";
		const activity: { name: string; type: number; url?: string; state?: string } = {
			// A custom activity needs a non-empty `name` per Discord; the visible text
			// rides in `state`. Other types put the text in `name`.
			name: isCustom ? "Custom Status" : text,
			type: presence.activityTypeCode,
		};
		if (isCustom && text) activity.state = text;
		if (presence.activityTypeCode === 1 && presence.activityUrl) activity.url = presence.activityUrl;
		payload.activities = [activity];
	}
	return payload;
}

/** Adapter construction options — all optional for back-compat. */
export interface CreateDiscordAdapterOptions {
	/** Per-account scope. Defaults to `"default"` (single-account). */
	accountId?: string;
	/**
	 * TEST SEAM: override how the connection is built. Production leaves this
	 * undefined and `connectDiscord` lazy-loads discord.js. Tests inject a fake.
	 */
	connectImpl?: (args: ConnectDiscordArgs) => Promise<DiscordConnection>;
}

export function createDiscordAdapter(opts: CreateDiscordAdapterOptions = {}): ChannelAdapter {
	const accountId = opts.accountId?.trim() || DISCORD_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectDiscord;
	// Resolver bound to THIS adapter's account, handed to `rewriteKnownMentions`
	// so a plain `@handle` the agent typed becomes a `<@id>` ping when (and only
	// when) the inbound directory cache has seen that handle for this account.
	const resolveMention = (handle: string): string | undefined => resolveDiscordHandle(accountId, handle);
	// Render an outbound chunk: rewrite known `@handle` mentions to `<@id>` FIRST
	// (so the converter sees a real mention token), then markdown→Discord, with the
	// raw chunk as the empty-render fallback (a syntax-only chunk must still send).
	const renderOutbound = (chunk: string): string => {
		const withMentions = rewriteKnownMentions(chunk, resolveMention);
		const rendered = markdownToDiscord(withMentions);
		return discordTextIsEmpty(rendered) ? withMentions : rendered;
	};
	let connection: DiscordConnection | null = null;
	// The ChannelStartContext doesn't carry the config, but the manager ALWAYS
	// calls `isConfigured(cfg, env)` immediately before `start(ctx)` — so we
	// capture the config + env it passed there and read the token from them in
	// start(). This avoids a second config load and keeps the adapter pure.
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	// Health flags mirrored from the connection lifecycle so health() never has to
	// round-trip Discord on the hot path (cron timer / send pre-flight).
	//   - `connected` flips true on a successful login + ready.
	//   - `tokenInvalid` is STICKY: an auth error means the token is dead and the
	//     only recovery is `brigade channels add --channel discord` with a new token.
	let connected = false;
	let tokenInvalid = false;

	/**
	 * Cheap SYNCHRONOUS gate: should this inbound trigger autoThread creation? True
	 * only when the feature is on, the message isn't already in a thread, and it's
	 * a guild text message carrying text + the ids needed to anchor a thread. Keeps
	 * the non-autoThread inbound path fully synchronous.
	 */
	const shouldAutoThread = (msg: DiscordInboundMessage): boolean => {
		if (msg.threadId) return false; // already in a thread
		const cfg = lastConfig;
		if (!cfg || !connection) return false;
		if (!resolveDiscordAutoThread(cfg).enabled) return false;
		// Guild text message only (a DM has no guildId; a reaction/callback carries no text).
		return Boolean(
			(msg.guildId ?? "").trim() &&
				(msg.conversationId ?? "").trim() &&
				(msg.messageId ?? "").trim() &&
				(msg.text ?? "").trim(),
		);
	};

	/**
	 * Phase 5 autoThread: create a thread off an inbound guild text message and
	 * return the new thread id (caller guards with {@link shouldAutoThread}).
	 * Returns the message's existing `threadId` (undefined) on any failure so the
	 * reply stays un-threaded.
	 *
	 * Thread naming: `"first-message"` uses the inbound's first line; `"generated"`
	 * would use an LLM-titled name, but Brigade has no simple-completion helper —
	 * so `"generated"` FALLS BACK to the first-message name here (no completion
	 * runtime is built).
	 */
	const maybeAutoThread = async (msg: DiscordInboundMessage): Promise<string | undefined> => {
		const existing = msg.threadId;
		const cfg = lastConfig;
		if (!cfg || !connection) return existing;
		const auto = resolveDiscordAutoThread(cfg);
		const channelId = (msg.conversationId ?? "").trim();
		const messageId = (msg.messageId ?? "").trim();
		const text = (msg.text ?? "").trim();
		// Name source: first-message (or generated → fallback to first-message until
		// a completion runtime exists).
		const name = sanitizeThreadName(text, messageId);
		try {
			const created = await connection.createThreadFromMessage(channelId, messageId, {
				name,
				autoArchiveMinutes: auto.autoArchiveMinutes,
			});
			return created ?? existing;
		} catch {
			return existing;
		}
	};

	const adapter: DiscordAdapter = {
		id: DISCORD_CHANNEL_ID,
		label: "Discord",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			// Capture for start() — the manager calls this right before start(ctx).
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!discordChannelEnabled(cfg)) return false;
			// Need a resolvable bot token (config `${VAR}` ref, sealed token, or
			// DISCORD_BOT_TOKEN env).
			if (!resolveDiscordBotToken(cfg, accountId, env ?? process.env)) return false;
			// Multi-account follow-up: when the operator declares >1 account, the
			// plugin path owns lifecycle and the legacy single adapter steps aside.
			const isLegacyAdapter = accountId === DISCORD_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listDiscordAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			// Resolve the token from the config the manager handed isConfigured().
			// Fall back to a fresh load defensively (e.g. a direct start() in a test
			// that skipped isConfigured).
			const cfg = lastConfig ?? (await loadStartConfig());
			const botToken = resolveDiscordBotToken(cfg, accountId, lastEnv);
			if (!botToken) {
				ctx.log("Discord not started — no bot token resolved (set channels.discord.botToken or DISCORD_BOT_TOKEN).");
				return;
			}
			// Optional proxy — routes the REST + Gateway websocket through it on
			// networks where discord.com is blocked. Empty → direct (unchanged).
			const proxyUrl = resolveDiscordProxyUrl(cfg, accountId, lastEnv);
			// The native slash-command manifest, derived from Brigade's central
			// channel commands; registered right after the connection is live (below).
			const commandManifest = buildDiscordCommandManifest(buildBundledCommands(adapter));
			// Resolve the optional bot presence to apply on (re)connect (Phase 5).
			const presencePayload = mapDiscordPresencePayload(resolveDiscordPresence(cfg));
			const conn = await connectImpl({
				botToken,
				...(proxyUrl ? { proxyUrl } : {}),
				...(presencePayload ? { presence: presencePayload } : {}),
				accountId,
				log: ctx.log,
				onConnected: () => {
					connected = true;
					tokenInvalid = false;
					ctx.log("Discord ready");
					ctx.onConnected?.();
				},
				onTokenInvalid: () => {
					connected = false;
					tokenInvalid = true;
					ctx.log("Discord token was rejected. Run `brigade channels add --channel discord` with a fresh bot token.");
					ctx.onLoggedOut?.();
				},
				onMessage: (msg) => {
					// Build the inbound with a resolved thread id. The dispatch is
					// SYNCHRONOUS when no thread needs creating (the common path, unchanged
					// behavior); only autoThread creation defers to a microtask.
					const dispatch = (threadId: string | undefined): void => {
						void ctx.onInbound({
							channel: DISCORD_CHANNEL_ID,
							accountId,
							conversationId: msg.conversationId,
							messageId: msg.messageId,
							messageTimestampMs: msg.messageTimestampMs,
							from: msg.from,
							fromName: msg.fromName,
							text: msg.text,
							chatType: msg.chatType,
							isGroup: msg.chatType === "group",
							threadId,
							// Discord routes on guildId + member role ids (NOT teamId — that
							// is Slack's workspace tier; setting it would risk colliding with
							// a Slack team binding).
							guildId: msg.guildId,
							memberRoleIds: msg.memberRoleIds,
							mentions: msg.mentions,
							replyTo: msg.replyTo,
							// Edit provenance rides through so the central pipeline / agent see
							// "this was an edit".
							...(msg.edited ? { edited: true } : {}),
							// Deferred media thunk rides through untouched — the pipeline
							// resolves it only after the access gate admits the sender.
							resolveMedia: msg.resolveMedia,
							raw: msg.raw,
						});
					};
					// Phase 5 autoThread: when enabled (and this is a fresh guild text
					// message), spawn a thread off the message and route the reply into it.
					// `shouldAutoThread` is a cheap synchronous gate so the non-autoThread
					// path stays fully synchronous.
					if (shouldAutoThread(msg)) {
						void maybeAutoThread(msg).then(dispatch).catch(() => dispatch(msg.threadId));
					} else {
						dispatch(msg.threadId);
					}
				},
				// Inbound reaction → synthesise a short note and route it through the
				// SAME inbound pipeline as a normal message so the access gate + routing
				// apply uniformly. The note carries the added emoji(s) + the target id.
				//
				// GATED by `channels.discord.reactionNotifications` (default "own") so a
				// stranger's reaction in an admitted channel no longer spams the agent:
				//   off → drop all; own → only reactions on the bot's own messages;
				//   all → route every reaction; allowlist → only allow-listed reactors.
				onReaction: (msg) => {
					if (!msg.reaction) return;
					if (!shouldNotifyReaction(msg, lastConfig, connection?.selfId() ?? undefined, accountId)) return;
					const note = buildReactionNote(msg.reaction.emojis, msg.reaction.targetMessageId, msg.fromName);
					void ctx.onInbound({
						channel: DISCORD_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: note,
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						...(msg.guildId !== undefined ? { guildId: msg.guildId } : {}),
						...(msg.memberRoleIds !== undefined ? { memberRoleIds: msg.memberRoleIds } : {}),
						reaction: msg.reaction,
						raw: msg.raw,
					});
				},
				// Button press → emit an InboundMessage carrying `callbackQuery` so the
				// central pipeline's approval-callback path resolves it. The connection
				// has already acked the press.
				onCallbackQuery: (msg) => {
					if (!msg.callbackQuery) return;
					void ctx.onInbound({
						channel: DISCORD_CHANNEL_ID,
						accountId,
						conversationId: msg.conversationId,
						from: msg.from,
						...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
						text: "",
						chatType: msg.chatType,
						isGroup: msg.chatType === "group",
						...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
						...(msg.guildId !== undefined ? { guildId: msg.guildId } : {}),
						...(msg.memberRoleIds !== undefined ? { memberRoleIds: msg.memberRoleIds } : {}),
						callbackQuery: msg.callbackQuery,
						raw: msg.raw,
					});
				},
			});
			connection = conn;
			// Register the native slash commands now that the connection exists.
			// `connectDiscord` resolves once the first connect (or terminal failure)
			// settles, so a successful boot is already live here. Best-effort: a
			// registration failure is logged inside `registerCommands` and never
			// blocks startup. When the token was rejected we skip (nothing to push).
			if (connected && !tokenInvalid) {
				void conn.registerCommands(commandManifest).catch(() => {});
			}
		},

		async stop(): Promise<void> {
			await connection?.close();
			connection = null;
			connected = false;
		},

		/**
		 * Synchronous read of the cached connection state:
		 *   - `{ ok: true }` once the Gateway is live.
		 *   - `{ ok: false, kind: "logged-out" }` after an auth error (sticky; re-token).
		 *   - `{ ok: false, kind: "starting" }` between start() and first connect.
		 *   - `{ ok: false, kind: "disconnected" }` for a transient drop mid-reconnect.
		 */
		health(): ChannelHealth {
			if (tokenInvalid || connection?.isTokenInvalid()) {
				return {
					ok: false,
					kind: "logged-out",
					reason: "Discord token was rejected — Brigade can't send until a new token is set.",
					remediation: "Run `brigade channels add --channel discord` and paste a fresh bot token.",
				};
			}
			if (!connection) {
				return { ok: false, kind: "starting", reason: "Discord adapter is not started yet." };
			}
			if (!connected || !connection.isConnected()) {
				return {
					ok: false,
					kind: "disconnected",
					reason: "Discord is reconnecting — sends will fail until the Gateway resumes.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<void> {
			if (!connection) throw new Error("Discord channel is not started");
			if (tokenInvalid || connection.isTokenInvalid()) {
				throw new Error("Discord token is invalid — run `brigade channels add --channel discord` with a new token, then retry.");
			}
			const threadId = opts?.threadId;
			// Native reply target — applied to the FIRST chunk only (threading every
			// chunk of a long reply is redundant once the first lands). Omitted →
			// unthreaded send (unchanged).
			const replyToMessageId = opts?.replyToId;
			const sendExtras: { threadId?: string } = {};
			if (threadId) sendExtras.threadId = threadId;
			// Chunk on the RAW markdown so fences/paragraphs aren't shredded, then
			// convert each chunk to Discord markup and send. A chunk whose rendered
			// markup is empty (syntax-only) is re-sent as the raw chunk.
			const chunks = chunkText(text, { limit: DISCORD_TEXT_LIMIT });
			// A silent send rides through on every chunk (SuppressNotifications).
			const silentOpt = opts?.silent ? { silent: true } : {};
			let first = true;
			for (const chunk of chunks) {
				const replyOpt = first && replyToMessageId ? { replyToMessageId } : {};
				const body = renderOutbound(chunk);
				if (body.trim().length === 0) continue;
				await connection.sendText(conversationId, body, { ...sendExtras, ...silentOpt, ...replyOpt });
				first = false;
			}
		},

		/**
		 * Open a LIVE reply stream — the gateway feeds the accumulating answer text
		 * via `update()`, this edits one Discord message in place (throttled
		 * ~1×/sec), and `finalize()` settles it on turn end. Returns `null` when
		 * streaming is disabled in config (`channels.discord.liveStream` is not true)
		 * OR the connection isn't live, so the pipeline falls back to the single
		 * final `sendText` — byte-unchanged from before streaming existed.
		 *
		 * Each draft chunk is rendered through the SAME markdown→Discord converter
		 * the final path uses. When the running answer exceeds the limit the stream
		 * finalizes the current message at a boundary and rolls overflow into a new
		 * message.
		 */
		beginReplyStream(conversationId: string, sendOpts?: OutboundSendOptions): ChannelReplyStream | null {
			if (!connection) return null;
			if (tokenInvalid || connection.isTokenInvalid()) return null;
			const cfg = lastConfig;
			if (!cfg || !discordLiveStreamEnabled(cfg)) return null;
			const conn = connection;
			const threadId = sendOpts?.threadId;
			const stream = createDraftStream({
				transport: {
					async postMessage(text, o): Promise<{ id: string }> {
						const sent = await conn.sendText(conversationId, text, {
							...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
						});
						return { id: sent.messageId };
					},
					async editMessage(id, text): Promise<void> {
						await conn.editMessageText(conversationId, id, text);
					},
				},
				...(threadId !== undefined ? { threadId } : {}),
				throttleMs: discordStreamThrottleMs(cfg),
				maxChars: DISCORD_TEXT_LIMIT,
				// Render each draft chunk to Discord markup (incl. known-mention rewrite);
				// fall back to the plain chunk when it renders empty (syntax-only).
				renderText: (chunk) => {
					return { text: renderOutbound(chunk) };
				},
			});
			return {
				update: (text: string) => stream.update(text),
				async finalize(finalText: string): Promise<{ messageId?: string } | void> {
					await stream.finalize(finalText);
					const ids = stream.messageIds();
					const last = ids[ids.length - 1];
					return last !== undefined ? { messageId: last } : undefined;
				},
				stop: () => stream.stop(),
			};
		},

		/**
		 * OPTIONAL reasoning lane (default OFF). When `channels.discord.
		 * surfaceReasoning` is true, split the raw reply's `<think>` trace out and
		 * send it as a separate `🧠 Reasoning:` message BEFORE the answer. When the
		 * config gate is off (the default) OR the reply carried no reasoning, this
		 * sends NOTHING — the answer message the pipeline sends afterward is
		 * byte-identical either way.
		 */
		async deliverReasoning(conversationId: string, rawReply: string, sendOpts?: OutboundSendOptions): Promise<void> {
			if (!connection) return;
			if (tokenInvalid || connection.isTokenInvalid()) return;
			const cfg = lastConfig;
			if (!cfg || !discordSurfaceReasoning(cfg)) return;
			const { reasoningText } = splitDiscordReasoning(rawReply ?? "");
			if (!reasoningText) return;
			// Reuse the adapter's own chunk+render send path so a long reasoning trace
			// is chunked at 2000 and formatted consistently with replies.
			await adapter.sendText(conversationId, reasoningText, sendOpts);
		},

		// Discord ids are user snowflakes; the pairing challenge card uses the
		// "account" label. The bot is a SEPARATE account from the operator (its own
		// app), so ownership is bootstrapped from the first CLI `pairing approve` —
		// see `botIsSeparateFromOperator`.
		pairing: { idLabel: "account" as const, botIsSeparateFromOperator: true },

		// Token-based setup wizard — `brigade channels add --channel discord` prompts
		// for the bot token and writes `channels.discord.botToken`. The OAuth invite
		// URL + the privileged "Message Content" gateway intent toggle CAN'T be
		// granted programmatically, so the two setup steps the operator must do by
		// hand are baked into the bot-token prompt copy:
		//   1. Enable the MESSAGE CONTENT intent (Bot → Privileged Gateway Intents),
		//      or Brigade can't read message text.
		//   2. Invite the bot with the `bot` + `applications.commands` scopes (OAuth2
		//      → URL Generator) + Send Messages / Read Message History / Add Reactions.
		setup: {
			credentialKeys: [
				{
					key: "botToken",
					prompt:
						"Discord bot token (Developer Portal → Bot → Reset Token). Also: enable the MESSAGE CONTENT intent (Bot → Privileged Gateway Intents) and invite the bot with the bot + applications.commands scopes.",
					secret: true,
					envVar: "DISCORD_BOT_TOKEN",
					docsUrl: "https://discord.com/developers/docs/topics/oauth2#bots",
				},
			],
			validateInput(key: string, value: string): string | null {
				const v = value.trim();
				// Allow a `${VAR}` ref through (resolved at runtime).
				if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(v)) return null;
				if (key === "botToken") {
					// Discord bot tokens are `<id>.<ts>.<secret>` (optionally `Bot `-prefixed).
					if (/^(Bot\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(v)) return null;
					return "That doesn't look like a Discord bot token — expected the `…. …. …` token from the Developer Portal.";
				}
				return null;
			},
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<void> {
			if (!connection) throw new Error("Discord channel is not started");
			await connection.sendMedia(conversationId, media);
		},

		async react(conversationId: string, messageId: string, emoji: string): Promise<void> {
			if (!connection) return; // cosmetic — refuse silently when not started
			await connection.react(conversationId, messageId, emoji);
		},

		async setComposing(conversationId: string, state: "composing" | "paused"): Promise<void> {
			if (!connection) return;
			await connection.setComposing(conversationId, state);
		},

		// Static capability flags. The central `message_action` tool PRE-CHECKS the
		// relevant flag here before calling `handleAction`, so an unsupported action
		// fails cleanly without touching the adapter.
		capabilities: DISCORD_CAPABILITIES,

		// Native component-button approvals. When a channel-routed turn raises an
		// approval, the central router calls `sendApprovalPrompt` to render the
		// question as buttons (payloads from the central codec); the press comes back
		// as `InboundMessage.callbackQuery` and is resolved centrally. A pathological
		// approval id that can't be encoded falls back to the text prompt.
		approvalCapability: {
			async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
				if (!connection) throw new Error("Discord channel is not started");
				const message = buildDiscordApprovalMessage({
					approvalId: params.approvalId,
					command: params.command,
					approvalKind: params.approvalKind,
					...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
				});
				if (!message) {
					// Couldn't build byte-safe buttons — let the router fall back to text.
					throw new Error("discord approval prompt: approval id too long for buttons");
				}
				await connection.sendInteractive(params.conversationId, message.text, message.rows, {
					...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
				});
			},
			authorizeApprover(p): { authorized: boolean; reason?: string } {
				return resolveDiscordApprover({
					cfg: p.cfg,
					...(p.senderId !== undefined ? { senderId: p.senderId } : {}),
					...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
				});
			},
		},

		// Edit / delete / react / reply a message + attach buttons. The manager
		// pre-checks the capability flag (above) before calling, so an action only
		// reaches here when Discord advertised support for it.
		async handleAction(p: {
			conversationId: string;
			action: ChannelMessageAction;
			accountId?: string;
			signal?: AbortSignal;
		}): Promise<ChannelMessageActionResult> {
			if (!connection) return { ok: false, error: "Discord channel is not started" };
			if (tokenInvalid || connection.isTokenInvalid()) {
				return { ok: false, error: "Discord token is invalid — re-token before acting on messages." };
			}
			const a = p.action;
			try {
				switch (a.kind) {
					case "edit": {
						const body = renderOutbound(a.text);
						await connection.editMessageText(p.conversationId, a.messageId, body);
						return { ok: true, messageId: a.messageId };
					}
					case "delete":
						await connection.deleteMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "pin":
						await connection.pinMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "unpin":
						await connection.unpinMessage(p.conversationId, a.messageId);
						return { ok: true, messageId: a.messageId };
					case "react":
						// An EMPTY emoji means "clear" (parity with WhatsApp/Telegram/Slack):
						// remove the bot's OWN reactions on this message; a non-empty emoji
						// adds as before.
						if (a.emoji.trim() === "") {
							await connection.removeOwnReactions(p.conversationId, a.messageId);
						} else {
							await connection.react(p.conversationId, a.messageId, a.emoji);
						}
						return { ok: true, messageId: a.messageId };
					case "reply": {
						// A reply is a send with a native reply reference; surface the new id.
						const sent = await connection.sendText(p.conversationId, a.text, {
							...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						});
						return { ok: true, messageId: sent.messageId };
					}
					case "buttons": {
						// Send a NEW message with a general button keyboard. The button ids
						// are prefixed/sanitized by the builder; a press arrives as
						// `callbackQuery` and routes through the pipeline as a turn (the
						// central approval path declines a general payload).
						const rows = buildDiscordButtonRows(a.buttons.map((row) => row.map((b) => ({ text: b.text, data: b.data }))));
						if (!rows) {
							return { ok: false, error: "no usable buttons (each needs a label + a data token ≤ 100 chars)" };
						}
						const body = renderOutbound(a.text);
						const sent = await connection.sendInteractive(p.conversationId, body, rows, {
							...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
						});
						return { ok: true, messageId: sent.messageId };
					}
					default:
						return { ok: false, error: `unsupported action kind` };
				}
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},

		selfId(): string | undefined {
			return connection?.selfId() ?? undefined;
		},

		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},

		lastEventAt(): number | null {
			return connection?.lastEventAt() ?? null;
		},
	};

	return adapter;
}

/**
 * Decide whether an inbound reaction-add should wake the agent, per the
 * `channels.discord.reactionNotifications` mode (default `"own"`):
 *   - `"off"`       → never;
 *   - `"own"`       → only when the reacted message was authored by the bot
 *                     (`reaction.targetAuthorId === selfId`);
 *   - `"all"`       → always (legacy behavior);
 *   - `"allowlist"` → only when the reactor (`msg.from`) is on the channel
 *                     allow-list — the central store list ∪ config `allowFrom`.
 * A null config defensively falls back to `"own"`. Reaction-REMOVE is unaffected
 * (handled in the connection's dedupe-release path).
 */
export function shouldNotifyReaction(
	msg: DiscordInboundMessage,
	cfg: BrigadeConfig | null,
	selfId: string | undefined,
	accountId?: string,
): boolean {
	const mode = cfg ? discordReactionNotifications(cfg) : "own";
	switch (mode) {
		case "off":
			return false;
		case "all":
			return true;
		case "allowlist": {
			const reactor = msg.from?.trim();
			if (!reactor) return false;
			const acct = accountId?.trim() || undefined;
			const storeAllow = readAllowFrom(DISCORD_CHANNEL_ID, acct);
			const configAllow = readDiscordAllowFrom(cfg);
			const allow = new Set([...storeAllow, ...configAllow].map((id) => id.trim()).filter(Boolean));
			return allow.has(reactor);
		}
		case "own":
		default: {
			const targetAuthor = msg.reaction?.targetAuthorId?.trim();
			return Boolean(selfId && targetAuthor && targetAuthor === selfId.trim());
		}
	}
}

/** Read `channels.discord.allowFrom` (config-declared allow-list ids) defensively. */
function readDiscordAllowFrom(cfg: BrigadeConfig | null): string[] {
	const slot = (cfg as { channels?: Record<string, { allowFrom?: unknown }> } | null)?.channels?.[DISCORD_CHANNEL_ID];
	const list = slot?.allowFrom;
	return Array.isArray(list) ? list.map((x) => String(x)) : [];
}

/**
 * Synthesise the agent-facing note for an inbound reaction. The reaction itself
 * carries no text, so the note ("<who> reacted :emoji: to message <id>") is what
 * the central pipeline routes through dispatchTurn so the agent has context.
 */
export function buildReactionNote(emojis: string[], targetMessageId: string, fromName?: string): string {
	const who = fromName?.trim() || "Someone";
	// A custom emoji surfaces as `name:id` — show just the name for the note.
	const emoji = emojis.map((e) => `:${e.includes(":") ? e.split(":")[0] : e}:`).join(" ");
	return `${who} reacted ${emoji} to message ${targetMessageId}.`;
}

/** Static Discord capability flags (shared by the legacy adapter + plugin meta). */
export const DISCORD_CAPABILITIES: ChannelCapabilities = {
	chatTypes: ["direct", "group", "thread"],
	reactions: true,
	edit: true,
	unsend: true,
	reply: true,
	threads: true,
	media: true,
	nativeCommands: true,
};

/**
 * The Discord adapter shape with its liveness extension. `createDiscordAdapter`
 * returns a `ChannelAdapter`, but the concrete object ALSO carries `lastEventAt`
 * (not in the base contract). Callers that need it cast through this type.
 */
export interface DiscordAdapter extends ChannelAdapter {
	/**
	 * Epoch ms of the most recent inbound event (liveness diagnostic), or null
	 * before the first event / when not started. Observability only — never flips
	 * health to "down" (a quiet channel is legitimately idle).
	 */
	lastEventAt(): number | null;
}

/**
 * Defensive config fallback for a direct `start()` that skipped `isConfigured`
 * (the manager always calls isConfigured first, so this is the rare path).
 */
async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig();
}
