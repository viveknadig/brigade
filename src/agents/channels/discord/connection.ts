/**
 * Discord connection (Gateway WebSocket inbound + REST outbound).
 *
 * The Brigade analogue of `slack/connection.ts`, on top of discord.js v14. A
 * single `Client` owns BOTH halves: the Gateway websocket delivers INBOUND
 * events (no public URL needed — the local-first default, analogous to Slack
 * Socket Mode / Telegram long-polling), and the same Client's REST drives every
 * OUTBOUND call (send / edit / delete / react / upload / typing). `discord.js`
 * is lazy-imported here (`await import("discord.js")` inside `connectDiscord`)
 * so a non-Discord boot never pays for it; types are `type`-only on the static
 * import so the static import never pulls the runtime in.
 *
 * Lifecycle:
 *   - `client.login(botToken)` BOOTSTRAPS the connection. An invalid token
 *     rejects login → TERMINAL (the only fix is a fresh token, mirroring Slack's
 *     `tokenInvalid`). The bot's own user id is cached on `ClientReady` (the
 *     group ACL needs it to detect `<@bot>` mentions + to filter the bot's own
 *     echoes; without it group messages never reach the agent and the bot could
 *     reply to itself).
 *   - Event handlers subscribe messageCreate / messageUpdate (edit) /
 *     messageDelete / messageReactionAdd / messageReactionRemove /
 *     interactionCreate (button presses = approval + general callbacks, and
 *     slash commands). Each normalizes the payload into a `DiscordInboundMessage`
 *     and routes it via `onMessage` / `onCallbackQuery` / `onReaction`.
 *     Attachment bytes are downloaded via a DEFERRED `resolveMedia` thunk — only
 *     after the central access gate admits the sender (mirrors Slack/Telegram).
 *   - discord.js auto-reconnects the Gateway internally; we SUPERVISE the initial
 *     `.login()` with the SAME backoff curve as Slack (2s → 30s, ×1.8, ±25%) and
 *     go terminal on an auth error.
 *   - Events are de-duplicated by message id (a redelivered event after a
 *     reconnect must not double-run the agent).
 */

import {
	chunkText,
	createDedupeCache,
	nextBackoffDelay,
	type InboundMediaAttachment,
	type InboundReplyContext,
	type OutboundMedia,
} from "../sdk.js";
import { maskProxyUrl } from "./account-config.js";
import { type DiscordActionRow } from "./components.js";
import { rememberDiscordUser } from "./directory-cache.js";
import {
	assembleDiscordText,
	buildDiscordSenderName,
	discordChannelType,
	discordThreadId,
	expandDiscordTokens,
	extractDiscordMemberRoleIds,
	extractDiscordMentions,
	extractDiscordReplyContext,
	hasInboundMedia,
	isThreadChannel,
	resolveInboundAttachments,
	type DiscordAttachmentLike,
	type DiscordMessageLike,
} from "./inbound-extras.js";
import { buildDiscordAttachment, downloadDiscordAttachment } from "./media.js";
import { isDiscordUserMessageType, resolveDiscordSystemEvent } from "./system-events.js";

/* ───────────────────────── reconnect backoff ───────────────────────── */
// Shares the neutral `nextBackoffDelay` curve with every other channel (see
// `channels/backoff.ts`), tuned to the SAME schedule WhatsApp + Telegram + Slack
// use (2s → 30s, ×1.8, ±25%). The constants live here so Discord owns its own
// knobs; the arithmetic is the shared helper's.

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

/**
 * Jittered exponential backoff for reconnect attempt `attempt` (0-based). Thin
 * wrapper over the neutral `nextBackoffDelay` helper — kept as a named export so
 * `index.ts` + the connection tests have a stable entry point.
 */
export function discordBackoffDelay(attempt: number): number {
	return nextBackoffDelay({
		attempt,
		initialMs: RECONNECT_INITIAL_MS,
		maxMs: RECONNECT_MAX_MS,
		factor: RECONNECT_FACTOR,
		jitter: RECONNECT_JITTER,
	});
}

/** Discord's hard per-message content limit (chars). Sends chunk under this. */
const DISCORD_MESSAGE_LIMIT = 2_000;

/* ───────────────────────── normalized inbound shape ───────────────────────── */

/** A normalized inbound Discord message (text and/or attachments). Mirrors `SlackInboundMessage`. */
export interface DiscordInboundMessage {
	/** Channel id (the conversation id). For a thread this is the thread channel id. */
	conversationId: string;
	/** Discord message id (snowflake) — surfaces for reply / edit / delete targeting. */
	messageId?: string;
	/** When Discord created the message (epoch ms). */
	messageTimestampMs?: number;
	/** Sender user id (snowflake). */
	from: string;
	/** Sender display name (nickname / global name / username). */
	fromName?: string;
	/** Plain message text (token-expanded). May be empty for attachment-only messages. */
	text: string;
	/** `direct` (DM) or `group` (guild text / thread). */
	chatType: "direct" | "group";
	/**
	 * Guild (server) id this message arrived in — feeds the route resolver's
	 * `binding.guild` (+ `guild+roles`) tier. Discord uses `guildId`, NOT `teamId`
	 * (that tier is Slack's workspace id); a Discord inbound never sets `teamId` so
	 * it can't collide with a Slack team binding.
	 */
	guildId?: string;
	/**
	 * The sending member's guild-role ids (ids only — never names). Populated for a
	 * guild message; empty/omitted for a DM. The resolver's `guild+roles` tier
	 * matches when ANY of these overlaps a binding's `roles[]`.
	 */
	memberRoleIds?: string[];
	/** Thread channel id, when the message belongs to a thread. */
	threadId?: string;
	/** User ids `<@…>`-mentioned (incl. the bot's own id when addressed). */
	mentions?: string[];
	/** Quoted-reply context, when this message replies to another. */
	replyTo?: InboundReplyContext;
	/**
	 * DEFERRED media download. The connection layer does NOT download eagerly —
	 * the pipeline invokes this ONLY after the access gate admits the sender, so a
	 * blocked stranger's attachment is never fetched. Resolves to an empty array
	 * for text-only messages.
	 */
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
	/**
	 * Inline-button callback context — present ONLY when this inbound is a button
	 * press rather than a typed message. `data` is the opaque payload the pressed
	 * button declared at send time (an approval-callback codec string OR a
	 * general-prefixed token); `callbackId` is the interaction id (so the press
	 * can be acked). Undefined for ordinary messages.
	 */
	callbackQuery?: { data: string; callbackId: string };
	/** True when this inbound is a message edit (text carries the NEW text). */
	edited?: boolean;
	/**
	 * Inbound reaction context — present ONLY when this inbound is a reaction-add.
	 * `emojis` are the newly-added reaction emoji name(s); `targetMessageId` is the
	 * message they landed on; `targetAuthorId` is the author of the reacted message
	 * (so the adapter can gate `reactionNotifications: "own"`). Undefined for typed
	 * messages.
	 */
	reaction?: { emojis: string[]; targetMessageId: string; targetAuthorId?: string };
	/** Raw discord.js object (for adapters that need more). */
	raw: unknown;
}

/* ───────────────────────── injectable Discord surfaces ───────────────────────── */

/**
 * The minimal slice of discord.js's `Client` the connection drives. Declared as
 * an interface (rather than importing the concrete class) so tests inject a fake
 * with zero network — the runtime path builds a real `Client` and it
 * structurally satisfies this shape.
 */
export interface DiscordClientLike {
	/** Subscribe a Gateway event handler (`messageCreate`, `interactionCreate`, …). */
	on(event: string, handler: (...args: never[]) => unknown): unknown;
	once(event: string, handler: (...args: never[]) => unknown): unknown;
	/** Open the Gateway connection with the bot token. Rejects on an invalid token. */
	login(token: string): Promise<string>;
	/** Tear down the connection + websocket. */
	destroy(): Promise<void> | void;
	/** The bot user once ready (carries `.id` + `.username`), else null. */
	user: { id?: string; username?: string } | null;
	/** REST handle for application-command registration + raw calls. */
	rest?: { put(route: unknown, options?: { body?: unknown }): Promise<unknown> };
	/** Resolve a channel by id (used by outbound to fetch the send target). */
	channels: {
		fetch(id: string): Promise<DiscordSendChannelLike | null>;
	};
	/** Resolve a user by id (used to open a DM channel). */
	users?: {
		fetch(id: string): Promise<{ createDM(): Promise<DiscordSendChannelLike> } | null>;
	};
}

/** The outbound surface a resolved channel exposes (send / typing). */
export interface DiscordSendChannelLike {
	id?: string;
	/**
	 * discord.js `ChannelType` enum value. A `GuildForum` (15) / `GuildMedia` (16)
	 * channel REJECTS a plain `.send()` — the outbound path must open a thread
	 * (forum post) instead (Fix 2b).
	 */
	type?: number;
	/** True for a text-capable channel (guild text, DM, thread). */
	isTextBased?: () => boolean;
	/**
	 * Post a message. `options` is discord.js `MessageCreateOptions` (content +
	 * optional `components` + `files` + `reply` + `allowedMentions`). Returns the
	 * sent message (carrying `.id`).
	 */
	send(options: DiscordSendOptions): Promise<DiscordSentMessageLike>;
	/**
	 * Thread manager — present on forum/media/text channels. `create` opens a new
	 * thread; for a forum/media channel it MUST carry a starter `message` (Discord
	 * rejects an empty forum post). Used by the forum auto-thread path (Fix 2b).
	 */
	threads?: {
		create(options: DiscordThreadCreateOptions): Promise<DiscordThreadCreateResult>;
	};
	/** Fetch a message in this channel by id (for edit / delete / react). */
	messages?: {
		fetch(id: string): Promise<DiscordSentMessageLike | null>;
	};
	/** Show the typing indicator (best-effort). */
	sendTyping?: () => Promise<unknown>;
}

/** Forum/media post creation options (the subset the connection sets). */
export interface DiscordThreadCreateOptions {
	/** Thread title (Discord caps at 100 chars). */
	name: string;
	/** Starter message — REQUIRED for a forum/media post. */
	message: { content?: string; flags?: number };
}

/**
 * The created thread handle. discord.js returns a `ThreadChannel` carrying its
 * own `.id` and (on a forum post) the starter `.lastMessage` / a fetchable
 * starter message; we read whichever id is available.
 */
export interface DiscordThreadCreateResult {
	id?: string;
	/** Some discord.js versions expose the starter message directly. */
	lastMessage?: { id?: string } | null;
}

/** A sent / fetched message handle the outbound path acts on. */
export interface DiscordSentMessageLike {
	id?: string;
	edit(options: DiscordSendOptions | string): Promise<DiscordSentMessageLike>;
	delete(): Promise<unknown>;
	react(emoji: string): Promise<unknown>;
	/** Pin this message (Fix 2e). */
	pin?: () => Promise<unknown>;
	/** Unpin this message (Fix 2e). */
	unpin?: () => Promise<unknown>;
	/** The bot's own reactions live under `.reactions.cache`; used by removeOwnReactions. */
	reactions?: {
		cache?: Map<string, DiscordReactionLike> | Iterable<DiscordReactionLike>;
		removeAll?: () => Promise<unknown>;
	};
}

/** A reaction on a message (the subset removeOwnReactions reads). */
export interface DiscordReactionLike {
	emoji?: { name?: string | null; id?: string | null };
	/** True when the bot itself placed this reaction. */
	me?: boolean;
	/** Remove this reaction (optionally for a specific user). */
	users?: { remove(userId?: string): Promise<unknown> };
	remove?: () => Promise<unknown>;
}

/**
 * discord.js `AllowedMentionsTypes` parse values the connection sets. We
 * deliberately NEVER include `"everyone"` so an agent / prompt-injected
 * `@everyone` / `@here` in the content renders as plain text but does NOT
 * notify everyone — while explicit `<@id>` user + `<@&roleid>` role pings still
 * work (their type IS parsed).
 */
export type DiscordAllowedMentionParse = "users" | "roles";

/**
 * The `allowedMentions` shape the connection sets on every outbound send. `parse`
 * whitelists which mention CLASSES notify (we use `["users", "roles"]`);
 * omitting `"everyone"` is what kills the mass-ping vector. `repliedUser:false`
 * stops a native reply from also pinging the replied-to author.
 */
export interface DiscordAllowedMentions {
	parse?: DiscordAllowedMentionParse[];
	repliedUser?: boolean;
}

/** discord.js `MessageCreateOptions` subset the connection emits. */
export interface DiscordSendOptions {
	content?: string;
	components?: unknown[];
	files?: unknown[];
	reply?: { messageReference: string; failIfNotExists: boolean };
	allowedMentions?: DiscordAllowedMentions;
	/**
	 * Message flags bitfield. The connection sets `MessageFlags.SuppressNotifications`
	 * (1 << 12 = 4096) for a silent send (Fix 2c) so the recipient gets no push/ping.
	 */
	flags?: number;
}

/* ───────────────────────── channel-type + flag constants ───────────────────────── */

/**
 * discord.js `ChannelType` values for forum/media channels (Fix 2b). A plain
 * `.send()` to these is REJECTED — the connection opens a thread (forum post)
 * instead. Hardcoded so the connection never has to import the discord.js enum on
 * the (injected-fake) test path; the values are stable wire constants.
 */
const CHANNEL_TYPE_GUILD_FORUM = 15;
const CHANNEL_TYPE_GUILD_MEDIA = 16;

/** `MessageFlags.SuppressNotifications` (1 << 12) — a silent send (Fix 2c). */
const MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;

/** Discord thread titles are capped at 100 chars. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** True for a forum / media channel (which rejects a plain `.send()`). */
function isForumLikeChannel(channel: DiscordSendChannelLike): boolean {
	return channel.type === CHANNEL_TYPE_GUILD_FORUM || channel.type === CHANNEL_TYPE_GUILD_MEDIA;
}

/**
 * Derive a forum-post thread name from the first non-empty line of the body,
 * trimmed to {@link DISCORD_THREAD_NAME_LIMIT}. Falls back to a timestamp stub
 * when the body is empty so the post always has a title.
 */
function deriveForumThreadName(text: string): string {
	const firstLine = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	const name = firstLine.slice(0, DISCORD_THREAD_NAME_LIMIT).trim();
	return name || new Date().toISOString().slice(0, 16);
}

/**
 * The SAFE default `allowedMentions` applied to every outbound Discord send.
 * `parse: ["users", "roles"]` lets explicit `<@id>` / `<@&roleid>` mentions ping
 * as intended, while the absence of `"everyone"` means an `@everyone` / `@here`
 * that slipped into the content (agent text or a prompt injection) renders as
 * text and notifies no one. `repliedUser: false` keeps a native reply from
 * pinging the author it answers. A fresh object is returned per call so a send
 * can't mutate the shared default.
 */
export function safeDiscordAllowedMentions(): DiscordAllowedMentions {
	return { parse: ["users", "roles"], repliedUser: false };
}

/** The builders the connection needs from discord.js (injected for tests). */
export interface DiscordBuilders {
	/** Wrap `{ path, name }` into an `AttachmentBuilder`-shaped object. */
	buildAttachment(path: string, name: string): unknown;
	/** Turn a serializable button-row grid into discord.js `ActionRowBuilder[]`. */
	buildComponentRows(rows: DiscordActionRow[]): unknown[];
}

/** A discord.js Interaction (the subset Brigade reads). */
export interface DiscordInteractionLike {
	/** True for a button press (`isButton()`); a command interaction sets `isChatInputCommand()`. */
	isButton?: () => boolean;
	isChatInputCommand?: () => boolean;
	/** The button's `custom_id` (button interactions). */
	customId?: string;
	/** Slash-command name (command interactions). */
	commandName?: string;
	/** The interaction id (acked via the reply/deferUpdate path). */
	id?: string;
	channelId?: string;
	channel?: DiscordChannelLikeForInteraction | null;
	guildId?: string | null;
	user?: { id?: string; username?: string; globalName?: string | null };
	member?: { nickname?: string | null } | null;
	message?: { id?: string };
	/** Ack a button press silently (no visible change). */
	deferUpdate?: () => Promise<unknown>;
	/** Ack a slash command with an ephemeral ack. */
	reply?: (options: unknown) => Promise<unknown>;
	deferReply?: (options?: unknown) => Promise<unknown>;
	[key: string]: unknown;
}

interface DiscordChannelLikeForInteraction {
	id?: string;
	type?: number;
	isThread?: () => boolean;
	isDMBased?: () => boolean;
	[key: string]: unknown;
}

export interface ConnectDiscordArgs {
	/** Bot token (Bot-prefix already stripped by the resolver). NEVER logged. */
	botToken: string;
	/** Account namespace stamped on inbounds (single-account → "default"). */
	accountId?: string;
	/**
	 * Optional proxy URL all Discord REST calls (+ the Gateway websocket) route
	 * through. Use it on networks where `discord.com` is blocked. When omitted the
	 * connection is DIRECT (unchanged default).
	 */
	proxyUrl?: string;
	/** Called once `login` succeeds and the client is ready. */
	onConnected?: () => void;
	/** Called when the token is rejected — terminal, re-token required. */
	onTokenInvalid?: () => void;
	/** Called for every inbound message. */
	onMessage: (msg: DiscordInboundMessage) => void;
	/**
	 * Called for every inbound button press. The handler acks the press before
	 * this fires, so it only routes the normalized inbound (which carries
	 * `callbackQuery`). Optional — when omitted, presses are acked but not routed.
	 */
	onCallbackQuery?: (msg: DiscordInboundMessage) => void;
	/**
	 * Called for every inbound reaction-add. The normalized inbound carries
	 * `reaction: { emojis, targetMessageId }` and no text. Optional.
	 */
	onReaction?: (msg: DiscordInboundMessage) => void;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/**
	 * TEST SEAM: supply the Client instead of building a real one. Production
	 * leaves this undefined and discord.js is lazy-imported. The second `proxyUrl`
	 * arg is the resolved proxy (undefined for a direct connection).
	 */
	clientFactory?: (botToken: string, proxyUrl?: string) => DiscordClientLike;
	/** TEST SEAM: supply the builders (production lazy-imports discord.js). */
	buildersFactory?: () => DiscordBuilders;
	/** TEST SEAM: skip the real backoff sleep so reconnect tests run instantly. */
	sleepImpl?: (ms: number) => Promise<void>;
}

export interface DiscordConnection {
	/** The bot's user id once connected, else null (self id for mention/echo detection). */
	selfId(): string | null;
	/** The bot's username once connected, else null. */
	selfName(): string | null;
	/** Epoch ms of the most recent successful connect, else null. */
	connectedAt(): number | null;
	/**
	 * Epoch ms of the most recent INBOUND event of any kind, else null. Liveness
	 * signal: a Gateway can read "connected" while silently dead. Observability
	 * only — a quiet channel is legitimately idle, so this NEVER flips health.
	 */
	lastEventAt(): number | null;
	/** True once `login` succeeded and the client is ready. */
	isConnected(): boolean;
	/** True once an auth error marked the token terminally invalid. */
	isTokenInvalid(): boolean;
	/** Send a single text message. Returns the posted message's id. */
	sendText(channel: string, text: string, opts?: DiscordSendTextOpts): Promise<{ messageId: string }>;
	/**
	 * Send a message carrying component button `rows` (the native approval prompt /
	 * general buttons). `text` is the message content; `rows` is a serializable
	 * button grid the builders turn into ActionRows. Text is sent verbatim (no
	 * markdown pass) so the caller controls formatting.
	 */
	sendInteractive(channel: string, text: string, rows: DiscordActionRow[], opts?: DiscordSendTextOpts): Promise<{ messageId: string }>;
	/** Upload a media attachment via an AttachmentBuilder. */
	sendMedia(channel: string, media: OutboundMedia, opts?: DiscordSendMediaOpts): Promise<void>;
	/** React to a previous message with an emoji (unicode or `name:id` custom). */
	react(channel: string, messageId: string, emoji: string): Promise<void>;
	/** Remove EVERY reaction the bot itself placed on a message. Best-effort. */
	removeOwnReactions(channel: string, messageId: string): Promise<void>;
	/** Edit a previously-sent message's text. */
	editMessageText(channel: string, messageId: string, text: string): Promise<void>;
	/** Delete a message. */
	deleteMessage(channel: string, messageId: string): Promise<void>;
	/** Pin a message in a channel (Fix 2e). */
	pinMessage(channel: string, messageId: string): Promise<void>;
	/** Unpin a previously-pinned message (Fix 2e). */
	unpinMessage(channel: string, messageId: string): Promise<void>;
	/** Register the bot's application (slash) commands. Best-effort. */
	registerCommands(commands: unknown[]): Promise<void>;
	/** Show typing in a channel (Discord clears it after ~10s or on the next send). */
	setComposing(channel: string, state: "composing" | "paused"): Promise<void>;
	/** Read-receipt no-op (Discord bots can't mark-read). */
	markRead(): Promise<void>;
	/** Disconnect the Gateway + tear down. */
	close(): Promise<void>;
}

export interface DiscordSendTextOpts {
	/** Thread id — reply within this thread channel. */
	threadId?: string;
	/** Native reply target — the message id to reply under. */
	replyToMessageId?: string;
	/** Suppress the recipient's notification (SuppressNotifications flag) (Fix 2c). */
	silent?: boolean;
}

export interface DiscordSendMediaOpts {
	/** Thread id to upload into. */
	threadId?: string;
	/** Suppress the recipient's notification (SuppressNotifications flag) (Fix 2c). */
	silent?: boolean;
}

/* ───────────────────────── error classification ───────────────────────── */

/** Pull a message string off any thrown shape. */
function errorText(err: unknown): string {
	if (!err) return "";
	if (typeof err === "string") return err;
	const e = err as { message?: string; code?: unknown };
	return e.message ?? String(err);
}

/**
 * A Discord auth failure → the token is wrong / revoked / reset. Re-tokening is
 * the only fix; reconnecting with the same token loops forever. discord.js
 * surfaces a bad token on login as a `TokenInvalid` error / a message containing
 * "invalid token" / an "disallowed intents" privileged-intents rejection (which
 * is also terminal until the operator fixes the bot's intent settings).
 */
export function isDiscordUnauthorized(err: unknown): boolean {
	const name = (err as { name?: string })?.name ?? "";
	if (/TokenInvalid|DisallowedIntents/i.test(name)) return true;
	const code = (err as { code?: unknown })?.code;
	if (code === "TokenInvalid" || code === "DisallowedIntents") return true;
	return /invalid token|incorrect login|disallowed intents|used disallowed intents/i.test(errorText(err));
}

/* ───────────────────────── structured send-error decode (Fix 2d) ───────────────────────── */

/** Discord JSON error code: the bot lacks permission to act in the channel. */
const DISCORD_ERR_MISSING_PERMISSIONS = 50013;
/** Discord JSON error code: cannot send messages to this user (DM blocked / disabled). */
const DISCORD_ERR_CANNOT_SEND_TO_USER = 50007;

/** Pull the numeric Discord error `code` off a thrown discord.js error, if any. */
function discordErrorCode(err: unknown): number | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as { code?: unknown; rawError?: { code?: unknown } };
	const candidate = e.code !== undefined ? e.code : e.rawError?.code;
	if (typeof candidate === "number") return candidate;
	if (typeof candidate === "string" && /^\d+$/.test(candidate)) return Number(candidate);
	return undefined;
}

/**
 * Turn a raw discord.js send error into an operator-readable one for the two
 * actionable cases (Fix 2d). A 50013 (Missing Permissions) and a 50007
 * (cannot-send-to-user / DM blocked) each map to a specific remediation hint;
 * every other error is rethrown VERBATIM so nothing is masked. Wrapped around the
 * three send fns so `adapter.handleAction`'s catch surfaces the decoded message.
 */
function decodeDiscordSendError(err: unknown): Error {
	const code = discordErrorCode(err);
	if (code === DISCORD_ERR_MISSING_PERMISSIONS) {
		return new Error("Missing permission to post in this channel (need View Channel + Send Messages).");
	}
	if (code === DISCORD_ERR_CANNOT_SEND_TO_USER) {
		return new Error("Can't DM this user — they've blocked the bot or disabled DMs.");
	}
	return err instanceof Error ? err : new Error(typeof err === "string" ? err : String(err));
}

/** Strip a Discord token out of a string before it logs. */
export function redactDiscordToken(text: string, ...tokens: string[]): string {
	if (!text) return text;
	let out = text;
	for (const token of tokens) {
		if (token) out = out.split(token).join("<redacted>");
	}
	// Discord bot tokens look like `<base64 id>.<base64 ts>.<secret>`; mask a
	// plausible token fragment even if the exact token differs.
	out = out.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, "<redacted>");
	return out;
}

/* ───────────────────────── the connection ───────────────────────── */

export async function connectDiscord(args: ConnectDiscordArgs): Promise<DiscordConnection> {
	const accountId = args.accountId ?? "default";
	const sleep = args.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
	const safeLog = (msg: string, meta?: Record<string, unknown>) => {
		const redactedMsg = redactDiscordToken(msg, args.botToken);
		if (!meta) return args.log(redactedMsg);
		const redactedMeta: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(meta)) {
			redactedMeta[k] = typeof v === "string" ? redactDiscordToken(v, args.botToken) : v;
		}
		args.log(redactedMsg, redactedMeta);
	};

	const proxyUrl = (args.proxyUrl ?? "").trim();

	// ── lazy-load discord.js (production path only) ──
	// `builders` resolves in this precedence: an injected `buildersFactory` wins
	// (tests / a custom build); else the production path builds real discord.js
	// builders; else (a `clientFactory` with no builders supplied) a pass-through
	// fake that emits plain JSON. So a test injecting just a `clientFactory` gets
	// the pass-through, and a real boot gets real discord.js builders.
	let buildClient: (botToken: string) => DiscordClientLike;
	let builders: DiscordBuilders | undefined = args.buildersFactory ? args.buildersFactory() : undefined;
	if (args.clientFactory) {
		const factory = args.clientFactory;
		buildClient = (botToken: string) => factory(botToken, proxyUrl || undefined);
		builders ??= {
			buildAttachment: (p: string, name: string) => ({ attachment: p, name }),
			buildComponentRows: (rows: DiscordActionRow[]) => rows.map((row) => ({ components: row })),
		};
	} else {
		const discord = await import("discord.js");
		const { Client, GatewayIntentBits, Partials } = discord;
		// Optional proxy → a custom REST `makeRequest` via undici's ProxyAgent. A
		// missing/malformed proxy must not wedge the channel (logged, ignored).
		let rest: { makeRequest?: unknown } | undefined;
		if (proxyUrl) {
			try {
				const { ProxyAgent, fetch: undiciFetch } = await import("undici");
				const dispatcher = new ProxyAgent(proxyUrl);
				rest = {
					makeRequest: ((url: string, init: Record<string, unknown>) =>
						undiciFetch(url, { ...init, dispatcher } as never)) as unknown,
				};
				safeLog("discord routing through proxy", { account: accountId, proxy: maskProxyUrl(proxyUrl) });
			} catch (err) {
				safeLog("discord proxy setup failed — connecting directly", {
					account: accountId,
					proxy: maskProxyUrl(proxyUrl),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		buildClient = (_botToken: string) =>
			new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.MessageContent,
					GatewayIntentBits.GuildMessageReactions,
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.DirectMessageReactions,
				],
				// Partials so DM channels + uncached reactions/messages still fire events.
				partials: [Partials.Channel, Partials.Message, Partials.Reaction],
				...(rest ? { rest: rest as never } : {}),
			}) as unknown as DiscordClientLike;
		builders ??= {
			buildAttachment(p: string, name: string): unknown {
				return new discord.AttachmentBuilder(p, { name });
			},
			buildComponentRows(rows: DiscordActionRow[]): unknown[] {
				return rows.map((row) => {
					const r = new discord.ActionRowBuilder<import("discord.js").ButtonBuilder>();
					for (const b of row) {
						r.addComponents(
							new discord.ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(b.style as number),
						);
					}
					return r;
				});
			},
		};
	}
	// `builders` is always assigned by here (every branch sets it); the non-null
	// assertion documents that for the closures below.
	const resolvedBuilders: DiscordBuilders = builders;

	// ── connection state ──
	let selfId: string | null = null;
	let selfName: string | null = null;
	let connectedAtMs: number | null = null;
	let lastEventAtMs: number | null = null;
	const stampInboundEvent = (): void => {
		lastEventAtMs = Date.now();
	};
	let connected = false;
	let tokenInvalid = false;
	let closed = false;
	let reconnectAttempts = 0;
	let client: DiscordClientLike | null = null;
	let loopPromise: Promise<void> | null = null;

	// Dedupe inbound events by id — a redelivered event after a reconnect must not
	// double-run the agent. Per-connection lifetime.
	const eventDedupe = createDedupeCache({ maxEntries: 10_000, ttlMs: 60 * 60 * 1_000 });

	// Last inbound message id per channel — the target setComposing targets (Discord
	// shows typing per-channel, so we just need the channel; the map is kept for
	// parity / future per-message affordances).
	const lastInboundChannel = new Set<string>();

	/** Token-resolver lookups primed from the cached client (best-effort, sync). */
	const resolveLookups = (message: DiscordMessageLike): Parameters<typeof expandDiscordTokens>[1] => {
		// On a live message discord.js resolves mention display via the resolved
		// collections; expandDiscordTokens falls back to the bare id when a name
		// isn't cached. We pass resolvers that read the message's own resolved
		// mention caches when present.
		const users = new Map<string, string>();
		const mentionUsers = (message.mentions as { users?: Iterable<{ id?: string; username?: string; globalName?: string | null }> } | undefined)?.users;
		if (mentionUsers) {
			const iter = mentionUsers instanceof Map ? mentionUsers.values() : mentionUsers;
			for (const u of iter) {
				if (typeof u?.id === "string") users.set(u.id, (u.globalName || u.username || u.id) as string);
			}
		}
		return { user: (id) => users.get(id) };
	};

	/**
	 * Prime the account's handle→id directory cache (Fix 2a) from an inbound: the
	 * message author plus every resolved `<@…>` mention. This is what later lets
	 * the outbound path rewrite a plain `@handle` the agent typed into a real
	 * `<@id>` ping. Best-effort + side-effect-only — never throws into normalize.
	 */
	const primeDirectoryFromMessage = (message: DiscordMessageLike): void => {
		try {
			const author = message.author;
			if (author && typeof author.id === "string") {
				rememberDiscordUser(accountId, {
					id: author.id,
					username: author.username ?? undefined,
					displayName: (author.globalName ?? author.displayName ?? undefined) as string | undefined,
				});
			}
			const mentionUsers = (message.mentions as { users?: Iterable<{ id?: string; username?: string; globalName?: string | null; displayName?: string }> } | undefined)?.users;
			if (mentionUsers) {
				const iter = mentionUsers instanceof Map ? mentionUsers.values() : mentionUsers;
				for (const u of iter) {
					if (typeof u?.id !== "string") continue;
					rememberDiscordUser(accountId, {
						id: u.id,
						username: u.username ?? undefined,
						displayName: (u.globalName ?? u.displayName ?? undefined) as string | undefined,
					});
				}
			}
		} catch {
			/* directory priming is best-effort */
		}
	};

	/** Normalize a discord.js message into the deferred-media inbound shape. */
	const normalize = (message: DiscordMessageLike, opts?: { edited?: boolean }): DiscordInboundMessage | null => {
		const channelId = typeof message.channelId === "string" ? message.channelId : typeof message.channel?.id === "string" ? message.channel.id : "";
		if (!channelId) return null;
		primeDirectoryFromMessage(message);
		const resolve = resolveLookups(message);
		// Assembled text: content leads, with an embed-title/description fallback when
		// content is empty, plus appended `<sticker: …>` + `[Forwarded from …]` blocks
		// so an embed-only / sticker-only / forwarded message isn't dropped as empty.
		const text = assembleDiscordText(message, resolve);
		const chatType = discordChannelType(message);
		const threadId = discordThreadId(message);
		const mentions = extractDiscordMentions(message, selfId ?? undefined);
		const replyTo = extractDiscordReplyContext(message);
		const fromName = buildDiscordSenderName(message);
		const fromId = typeof message.author?.id === "string" ? message.author.id : channelId;
		// Discord routes on guildId + member role ids (NOT teamId — that's Slack's
		// workspace tier). A DM carries no guildId and no roles.
		const guildId = typeof message.guildId === "string" ? message.guildId : undefined;
		const memberRoleIds = guildId ? extractDiscordMemberRoleIds(message) : [];
		const messageId = typeof message.id === "string" ? message.id : undefined;
		const timestampMs = typeof message.createdTimestamp === "number" ? message.createdTimestamp : undefined;

		// DEFERRED media — captured by reference, not downloaded. The thunk is only
		// invoked by the pipeline after the access gate admits the sender.
		const carriesMedia = hasInboundMedia(message);
		const resolveMedia = carriesMedia
			? async (): Promise<InboundMediaAttachment[]> => {
					const atts = resolveInboundAttachments(message);
					if (atts.length === 0) return [];
					const out: InboundMediaAttachment[] = [];
					for (const att of atts) {
						const dl = await downloadDiscordAttachment({ attachment: att as DiscordAttachmentLike, log: safeLog });
						if (dl) out.push(dl);
					}
					return out;
				}
			: undefined;

		return {
			conversationId: channelId,
			...(messageId ? { messageId } : {}),
			...(timestampMs !== undefined ? { messageTimestampMs: timestampMs } : {}),
			from: fromId,
			...(fromName ? { fromName } : {}),
			text,
			chatType,
			...(guildId ? { guildId } : {}),
			...(memberRoleIds.length > 0 ? { memberRoleIds } : {}),
			...(threadId ? { threadId } : {}),
			...(mentions.length > 0 ? { mentions } : {}),
			...(replyTo ? { replyTo } : {}),
			...(opts?.edited ? { edited: true } : {}),
			...(resolveMedia ? { resolveMedia } : {}),
			raw: message,
		};
	};

	/** Is this message one the bot itself authored (its own echo)? */
	const isSelfAuthored = (message: DiscordMessageLike): boolean => {
		if (selfId && message.author?.id === selfId) return true;
		// A webhook / bot author with no resolvable user shouldn't loop us either,
		// but only OUR own id is a definite echo; other bots are allowed through.
		return false;
	};

	/**
	 * Best-effort resolve the parent of a reply into `replyTo.body` (+ `from`).
	 * Discord doesn't inline the replied-to text, so we fetch it: `fetchReference()`
	 * first (discord.js resolves the reference directly), then `channel.messages.fetch(id)`
	 * as a fallback. The body is the parent's assembled text (token-expanded), hard-capped.
	 * Mutates `normalized.replyTo` in place. Fully guarded — any error leaves the
	 * `{ messageId }`-only context untouched so delivery never blocks/fails.
	 */
	const backfillReplyBody = async (message: DiscordMessageLike, normalized: DiscordInboundMessage): Promise<void> => {
		const refId = message.reference?.messageId;
		if (!normalized.replyTo || normalized.replyTo.body || typeof refId !== "string" || !refId) return;
		try {
			let parent: DiscordMessageLike | null = null;
			if (typeof message.fetchReference === "function") {
				parent = await message.fetchReference();
			}
			if (!parent && typeof message.channel?.messages?.fetch === "function") {
				parent = await message.channel.messages.fetch(refId);
			}
			if (!parent) return;
			const body = assembleDiscordText(parent, resolveLookups(parent)).replace(/\n/g, " ").slice(0, 300);
			const from = typeof parent.author?.id === "string" ? parent.author.id : undefined;
			if (body || from) {
				normalized.replyTo = {
					...normalized.replyTo,
					...(body ? { body } : {}),
					...(from ? { from } : {}),
				};
			}
		} catch (err) {
			safeLog("discord reply-parent backfill failed", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Handle a messageCreate / messageUpdate event.
	 *
	 * ASYNC because of three best-effort REST hydrations (all guarded, all
	 * post-`normalize`, mirroring the Slack thread-backfill pattern):
	 *   - reply-parent backfill → fills `replyTo.body` so the agent sees what was
	 *     replied to (Fix 1b);
	 *   - system events (joins / pins / boosts / thread-created …) → synthesize a
	 *     concise note as the inbound text so the agent learns the event (Fix 1c);
	 *   - empty-payload hydration → re-pull a late / proxied empty-content message
	 *     once and re-assemble before bailing (Fix 1d).
	 */
	const handleMessage = async (message: DiscordMessageLike, opts?: { edited?: boolean }): Promise<void> => {
		try {
			stampInboundEvent();
			// Skip the bot's own messages (echoes) — a bot must never reply to itself.
			if (isSelfAuthored(message)) return;
			// Skip a message authored by ANY bot/webhook to avoid bot-loops (parity with
			// the conservative default; a human-only channel is the norm for Brigade).
			if (message.author?.bot === true) return;
			const id = typeof message.id === "string" ? message.id : "";
			if (!id) return;
			// Edits fold the edit timestamp into the key so a second edit still routes.
			const editStamp = opts?.edited && typeof message.editedTimestamp === "number" ? message.editedTimestamp : "";
			const key = opts?.edited ? `edit:${id}:${editStamp}` : id;
			if (!eventDedupe.claim(key)) return; // already seen

			// SYSTEM event (join / pin / boost / thread-created …): no user content, so
			// synthesize a concise note as the inbound text and route it (no debounce).
			// An UNMAPPED system type yields null → drop it. Checked BEFORE normalize so
			// a content-less system message isn't treated as an empty user message.
			if (!isDiscordUserMessageType(message.type)) {
				const channelId = typeof message.channelId === "string" ? message.channelId : typeof message.channel?.id === "string" ? message.channel.id : "";
				const note = resolveDiscordSystemEvent(message, channelId);
				if (!note) return; // unmapped system type — drop
				const normalized = normalize(message, opts);
				if (!normalized) return;
				normalized.text = note;
				args.onMessage(normalized);
				lastInboundChannel.add(normalized.conversationId);
				return;
			}

			let normalized = normalize(message, opts);
			if (!normalized) return;

			// Does this message need any async REST hydration? (Empty-payload re-pull OR
			// reply-parent backfill.) When NOTHING async applies — the common case — we
			// deliver SYNCHRONOUSLY so callers see the inbound on the same tick.
			const needsHydration = !normalized.text.trim() && !hasInboundMedia(message) && typeof message.fetch === "function";
			const refId = message.reference?.messageId;
			const needsReplyBackfill =
				!!normalized.replyTo &&
				!normalized.replyTo.body &&
				typeof refId === "string" &&
				!!refId &&
				(typeof message.fetchReference === "function" || typeof message.channel?.messages?.fetch === "function");

			if (!needsHydration && !needsReplyBackfill) {
				args.onMessage(normalized);
				lastInboundChannel.add(normalized.conversationId);
				return;
			}

			// Empty-payload hydration (Fix 1d): the MESSAGE CONTENT intent can deliver a
			// late / proxied payload with empty content + no media. Best-effort re-pull
			// the message once, re-assemble, and only bail if STILL empty.
			if (needsHydration) {
				try {
					const refetched = await message.fetch!();
					if (refetched && typeof refetched === "object") {
						const renorm = normalize(refetched, opts);
						if (renorm && (renorm.text.trim() || renorm.resolveMedia)) {
							normalized = renorm;
							message = refetched;
						}
					}
				} catch (err) {
					safeLog("discord empty-payload hydration failed", { error: err instanceof Error ? err.message : String(err) });
				}
			}

			// Reply-parent backfill (Fix 1b): fill `replyTo.body` from the parent message.
			await backfillReplyBody(message, normalized);

			args.onMessage(normalized);
			lastInboundChannel.add(normalized.conversationId);
		} catch (err) {
			safeLog("discord inbound handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/**
	 * Normalize a reaction-add into the inbound shape. Surfaces the single added
	 * emoji, the actor, and the target message id. Reactions carry no text.
	 */
	const normalizeReaction = (
		reaction: { emoji?: { name?: string | null; id?: string | null }; message?: DiscordMessageLike },
		user: { id?: string; bot?: boolean; username?: string },
	): DiscordInboundMessage | null => {
		const msg = reaction.message;
		const channel = typeof msg?.channelId === "string" ? msg.channelId : typeof msg?.channel?.id === "string" ? msg.channel.id : "";
		const target = typeof msg?.id === "string" ? msg.id : "";
		// A custom emoji surfaces as `name:id`; a unicode emoji as its char.
		const emojiName = reaction.emoji?.name ?? "";
		const emoji = reaction.emoji?.id ? `${emojiName}:${reaction.emoji.id}` : emojiName;
		if (!channel || !target || !emoji) return null;
		const fromId = typeof user?.id === "string" ? user.id : channel;
		if (selfId && fromId === selfId) return null; // the bot's own reaction
		if (user?.bot === true) return null; // ignore other bots' reactions
		const fromName = user?.username;
		const guildId = typeof msg?.guildId === "string" ? msg.guildId : undefined;
		// Author of the REACTED message — lets the adapter gate `reactionNotifications: "own"`.
		const targetAuthorId = typeof msg?.author?.id === "string" ? msg.author.id : undefined;
		return {
			conversationId: channel,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			chatType: msg?.guildId ? "group" : "direct",
			...(guildId ? { guildId } : {}),
			reaction: { emojis: [emoji], targetMessageId: target, ...(targetAuthorId ? { targetAuthorId } : {}) },
			raw: { reaction, user },
		};
	};

	/** Handle a messageReactionAdd event. */
	const handleReactionAdd = (
		reaction: { emoji?: { name?: string | null; id?: string | null }; message?: DiscordMessageLike },
		user: { id?: string; bot?: boolean; username?: string },
	): void => {
		try {
			stampInboundEvent();
			const key = `react:${user?.id}:${reaction.emoji?.name ?? reaction.emoji?.id}:${reaction.message?.id}`;
			if (!eventDedupe.claim(key)) return;
			const normalized = normalizeReaction(reaction, user);
			if (!normalized) return;
			args.onReaction?.(normalized);
		} catch (err) {
			safeLog("discord reaction handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/** Handle a messageReactionRemove event — release the add-dedupe key so a re-add re-routes. */
	const handleReactionRemove = (
		reaction: { emoji?: { name?: string | null; id?: string | null }; message?: DiscordMessageLike },
		user: { id?: string },
	): void => {
		stampInboundEvent(); // liveness: a removal is still inbound traffic
		eventDedupe.release(`react:${user?.id}:${reaction.emoji?.name ?? reaction.emoji?.id}:${reaction.message?.id}`);
	};

	/** Normalize a button-press interaction into the approval-callback inbound shape. */
	const normalizeButton = (interaction: DiscordInteractionLike): DiscordInboundMessage | null => {
		const value = typeof interaction.customId === "string" ? interaction.customId : "";
		if (!value) return null;
		const channel = typeof interaction.channelId === "string" ? interaction.channelId : typeof interaction.channel?.id === "string" ? interaction.channel.id : "";
		const fromId = typeof interaction.user?.id === "string" ? interaction.user.id : channel;
		if (!channel && !fromId) return null;
		const threadId = interaction.channel && isThreadChannel(interaction.channel) ? channel : undefined;
		const fromName = interaction.user?.username;
		return {
			conversationId: channel || fromId,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: "",
			chatType: interaction.guildId ? "group" : "direct",
			...(typeof interaction.guildId === "string" ? { guildId: interaction.guildId } : {}),
			...(threadId ? { threadId } : {}),
			callbackQuery: { data: value, callbackId: interaction.id ?? "" },
			raw: interaction,
		};
	};

	/**
	 * Normalize a slash-command interaction into an ordinary inbound message so the
	 * central command map (`/help`, `/status`, …) handles it. The command name is
	 * mapped to `/command` text.
	 */
	const normalizeSlash = (interaction: DiscordInteractionLike): DiscordInboundMessage | null => {
		const command = typeof interaction.commandName === "string" ? interaction.commandName : "";
		const channel = typeof interaction.channelId === "string" ? interaction.channelId : "";
		const fromId = typeof interaction.user?.id === "string" ? interaction.user.id : channel;
		if (!command || !channel) return null;
		const fromName = interaction.user?.username;
		return {
			conversationId: channel,
			from: fromId,
			...(fromName ? { fromName } : {}),
			text: `/${command}`,
			chatType: interaction.guildId ? "group" : "direct",
			...(typeof interaction.guildId === "string" ? { guildId: interaction.guildId } : {}),
			raw: interaction,
		};
	};

	/** Handle an interactionCreate event (button press OR slash command). */
	const handleInteraction = (interaction: DiscordInteractionLike): void => {
		try {
			stampInboundEvent();
			if (typeof interaction.isButton === "function" && interaction.isButton()) {
				// Ack the press silently first so Discord doesn't show "interaction
				// failed"; then route the normalized inbound.
				void interaction.deferUpdate?.().catch(() => {});
				const normalized = normalizeButton(interaction);
				if (normalized) args.onCallbackQuery?.(normalized);
				return;
			}
			if (typeof interaction.isChatInputCommand === "function" && interaction.isChatInputCommand()) {
				// Ack the command ephemerally so the client spinner clears; the real
				// reply is delivered by the pipeline as a normal channel message.
				void interaction.reply?.({ content: "On it.", ephemeral: true }).catch(() => {});
				const normalized = normalizeSlash(interaction);
				if (normalized) args.onMessage(normalized);
				return;
			}
		} catch (err) {
			safeLog("discord interaction handler error", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	/* ── event wiring ── */

	const wireClient = (c: DiscordClientLike): void => {
		// handleMessage is async (it does best-effort REST hydration for reply bodies /
		// empty payloads); it self-guards every path, so the promise is voided here.
		c.on("messageCreate", ((message: DiscordMessageLike) => void handleMessage(message)) as never);
		c.on("messageUpdate", ((_old: unknown, updated: DiscordMessageLike) => {
			// messageUpdate fires for non-content edits too (embeds resolving, pins);
			// only route when there's content to act on.
			if (updated && typeof updated === "object") void handleMessage(updated, { edited: true });
		}) as never);
		c.on("messageDelete", (() => {
			// A deleted message carries no routable content — just stamp liveness.
			stampInboundEvent();
		}) as never);
		c.on("messageReactionAdd", ((reaction: never, user: never) => handleReactionAdd(reaction, user)) as never);
		c.on("messageReactionRemove", ((reaction: never, user: never) => handleReactionRemove(reaction, user)) as never);
		c.on("interactionCreate", ((interaction: DiscordInteractionLike) => handleInteraction(interaction)) as never);
		// A privileged-intents (4014) or auth-failed (4004) Gateway CLOSE is terminal:
		// discord.js would otherwise loop reconnect attempts forever while health
		// stayed "connected". Flip the token-invalid flag so health goes "logged-out"
		// and the operator is told to fix intents / re-token. Any other close code
		// (e.g. 1006) is a normal transient drop discord.js recovers from on its own.
		c.on("shardDisconnect", ((closeEvent: { code?: number } | undefined) => {
			stampInboundEvent(); // a disconnect is still gateway traffic (liveness)
			const code = closeEvent?.code;
			if (code !== 4014 && code !== 4004) return;
			if (tokenInvalid) return;
			tokenInvalid = true;
			connected = false;
			safeLog("discord gateway closed with a terminal code — re-token / fix intents required", { code });
			args.onTokenInvalid?.();
		}) as never);
		// A token revoked / Gateway error mid-session surfaces on `error`; mark the
		// token invalid on an auth-class error so health flips to "logged-out".
		c.on("error", ((err: unknown) => {
			if (!isDiscordUnauthorized(err)) {
				safeLog("discord client error", { error: err instanceof Error ? err.message : String(err) });
				return;
			}
			if (tokenInvalid) return;
			tokenInvalid = true;
			connected = false;
			safeLog("discord token rejected mid-session — re-token required");
			args.onTokenInvalid?.();
		}) as never);
	};

	/* ── bootstrap + supervise ── */

	/** Build the client, wire events, login, cache identity. */
	const startOnce = async (): Promise<void> => {
		const c = buildClient(args.botToken);
		client = c;
		wireClient(c);
		// `clientReady` fires once the Gateway handshake + initial guild sync settle.
		c.once("clientReady", (() => {
			selfId = typeof c.user?.id === "string" ? c.user.id : null;
			selfName = typeof c.user?.username === "string" ? c.user.username : null;
		}) as never);
		// login() rejects on an invalid token (terminal); resolves once the Gateway
		// is identifying. We treat a resolved login as connected and read the cached
		// user id (clientReady may fire just after login resolves).
		await c.login(args.botToken);
		selfId = selfId ?? (typeof c.user?.id === "string" ? c.user.id : null);
		selfName = selfName ?? (typeof c.user?.username === "string" ? c.user.username : null);
	};

	/**
	 * The supervise loop — login, and on a transient setup failure reconnect with
	 * backoff. discord.js auto-reconnects the Gateway internally once logged in, so
	 * this loop mainly guards the initial login. A terminal auth error stops it.
	 */
	const superviseLoop = async (): Promise<void> => {
		while (!closed && !tokenInvalid) {
			try {
				await startOnce();
			} catch (err) {
				if (isDiscordUnauthorized(err)) {
					tokenInvalid = true;
					connected = false;
					safeLog("discord token rejected — re-token required; not connecting");
					args.onTokenInvalid?.();
					return;
				}
				if (closed) return;
				const delay = discordBackoffDelay(reconnectAttempts);
				reconnectAttempts += 1;
				if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
					safeLog("discord setup attempts exhausted — giving up until restart", { attempts: reconnectAttempts });
					return;
				}
				safeLog("discord setup failed — retrying", {
					attempt: reconnectAttempts,
					delayMs: delay,
					error: err instanceof Error ? err.message : String(err),
				});
				// Tear down the half-built client before retrying.
				await teardownClient();
				await sleep(delay);
				continue;
			}
			if (closed) {
				await teardownClient();
				return;
			}
			connected = true;
			connectedAtMs = Date.now();
			reconnectAttempts = 0;
			safeLog("discord connected", { account: accountId, self: selfName ? `@${selfName}` : selfId });
			args.onConnected?.();
			return;
		}
	};

	const teardownClient = async (): Promise<void> => {
		const c = client;
		client = null;
		if (c) {
			try {
				await c.destroy();
			} catch {
				/* already destroyed */
			}
		}
	};

	// Kick startup. `connectDiscord` resolves as soon as the FIRST connect (or
	// terminal failure) settles so the adapter's start() doesn't hang.
	let resolveInitial: () => void;
	const initial = new Promise<void>((resolve) => {
		resolveInitial = resolve;
	});
	const origOnConnected = args.onConnected;
	const origOnTokenInvalid = args.onTokenInvalid;
	args.onConnected = () => {
		origOnConnected?.();
		resolveInitial();
	};
	args.onTokenInvalid = () => {
		origOnTokenInvalid?.();
		resolveInitial();
	};
	loopPromise = superviseLoop().catch((err) => {
		safeLog("discord supervise loop crashed", { error: err instanceof Error ? err.message : String(err) });
	});
	await Promise.race([initial, loopPromise.then(() => undefined)]);

	/* ── outbound + control surface ── */

	const requireLive = (): DiscordClientLike => {
		if (tokenInvalid) throw new Error("Discord token is invalid — set a new bot token and restart.");
		if (!client) throw new Error("Discord channel is not started");
		return client;
	};

	/**
	 * Resolve the channel to send into. For a thread send the threadId IS the
	 * target channel (Discord threads are channels), so it wins over the base
	 * channel; otherwise the conversation channel is fetched. Returns the
	 * text-capable send channel or throws a clear error.
	 */
	const resolveSendChannel = async (channel: string, threadId?: string): Promise<DiscordSendChannelLike> => {
		const c = requireLive();
		const targetId = threadId || channel;
		const ch = await c.channels.fetch(targetId);
		if (!ch) throw new Error(`Discord: channel ${targetId} not found`);
		// A forum / media channel reports `isTextBased() === false` but IS a valid
		// send target — the post is created as a thread (Fix 2b). So we only reject
		// genuinely non-text channels (voice/category/…) that aren't forum-like.
		if (typeof ch.isTextBased === "function" && !ch.isTextBased() && !isForumLikeChannel(ch)) {
			throw new Error(`Discord: channel ${targetId} is not text-based`);
		}
		return ch;
	};

	/**
	 * Post a message to a resolved channel, auto-creating a forum/media thread when
	 * the target is a `GuildForum`/`GuildMedia` channel (Fix 2b) — those reject a
	 * plain `.send()`. The thread name is derived from the first non-empty content
	 * line. Returns the created message's id. Used by every text-ish send path.
	 */
	const postToChannel = async (ch: DiscordSendChannelLike, options: DiscordSendOptions): Promise<{ messageId: string }> => {
		if (isForumLikeChannel(ch)) {
			if (typeof ch.threads?.create !== "function") {
				throw new Error("Discord: forum/media channel cannot create a thread (missing threads.create)");
			}
			const name = deriveForumThreadName(options.content ?? "");
			const message: { content?: string; flags?: number } = {};
			if (options.content !== undefined) message.content = options.content;
			if (options.flags !== undefined) message.flags = options.flags;
			const created = await ch.threads.create({ name, message });
			const messageId = typeof created.lastMessage?.id === "string" ? created.lastMessage.id : typeof created.id === "string" ? created.id : "";
			return { messageId };
		}
		const sent = await ch.send(options);
		return { messageId: typeof sent.id === "string" ? sent.id : "" };
	};

	const sendText: DiscordConnection["sendText"] = async (channel, text, opts) => {
		try {
			const ch = await resolveSendChannel(channel, opts?.threadId);
			// SAFE allowed-mentions on EVERY send: explicit user/role pings still notify,
			// but a stray `@everyone`/`@here` (agent text or prompt injection) can't
			// mass-ping, and a reply won't ping the author it answers.
			const options: DiscordSendOptions = { content: text, allowedMentions: safeDiscordAllowedMentions() };
			// Silent send — suppress the recipient's notification (Fix 2c).
			if (opts?.silent) options.flags = MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS;
			// Native reply target — reply under the message being answered (only when not
			// threading, since a thread send is already scoped).
			if (opts?.replyToMessageId && !opts?.threadId) {
				options.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
			}
			return await postToChannel(ch, options);
		} catch (err) {
			throw decodeDiscordSendError(err);
		}
	};

	const sendInteractive: DiscordConnection["sendInteractive"] = async (channel, text, rows, opts) => {
		try {
			const ch = await resolveSendChannel(channel, opts?.threadId);
			const components = resolvedBuilders.buildComponentRows(rows);
			const options: DiscordSendOptions = { content: text, components, allowedMentions: safeDiscordAllowedMentions() };
			if (opts?.silent) options.flags = MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS;
			if (opts?.replyToMessageId && !opts?.threadId) {
				options.reply = { messageReference: opts.replyToMessageId, failIfNotExists: false };
			}
			const sent = await ch.send(options);
			return { messageId: typeof sent.id === "string" ? sent.id : "" };
		} catch (err) {
			throw decodeDiscordSendError(err);
		}
	};

	const sendMedia: DiscordConnection["sendMedia"] = async (channel, media, opts) => {
		try {
			const ch = await resolveSendChannel(channel, opts?.threadId);
			// validateOutboundMediaPath runs inside buildDiscordAttachment (throws on a
			// refused path).
			const att = buildDiscordAttachment(media);
			const file = resolvedBuilders.buildAttachment(att.path, att.name);
			const options: DiscordSendOptions = { files: [file], allowedMentions: safeDiscordAllowedMentions() };
			if (opts?.silent) options.flags = MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS;
			if (att.caption) options.content = att.caption;
			await ch.send(options);
		} catch (err) {
			throw decodeDiscordSendError(err);
		}
	};

	const fetchMessage = async (channel: string, messageId: string): Promise<DiscordSentMessageLike> => {
		const ch = await resolveSendChannel(channel);
		const fetchFn = ch.messages?.fetch;
		if (typeof fetchFn !== "function") throw new Error("Discord: channel cannot fetch messages");
		const msg = await fetchFn.call(ch.messages, messageId);
		if (!msg) throw new Error(`Discord: message ${messageId} not found`);
		return msg;
	};

	const editMessageText: DiscordConnection["editMessageText"] = async (channel, messageId, text) => {
		const msg = await fetchMessage(channel, messageId);
		await msg.edit({ content: text });
	};

	const deleteMessage: DiscordConnection["deleteMessage"] = async (channel, messageId) => {
		const msg = await fetchMessage(channel, messageId);
		await msg.delete();
	};

	const pinMessage: DiscordConnection["pinMessage"] = async (channel, messageId) => {
		const msg = await fetchMessage(channel, messageId);
		if (typeof msg.pin !== "function") throw new Error("Discord: message cannot be pinned");
		await msg.pin();
	};

	const unpinMessage: DiscordConnection["unpinMessage"] = async (channel, messageId) => {
		const msg = await fetchMessage(channel, messageId);
		if (typeof msg.unpin !== "function") throw new Error("Discord: message cannot be unpinned");
		await msg.unpin();
	};

	const react: DiscordConnection["react"] = async (channel, messageId, emoji) => {
		const name = emoji.trim();
		if (!name) return;
		try {
			const msg = await fetchMessage(channel, messageId);
			await msg.react(name);
		} catch (err) {
			// Reactions are cosmetic — a missing emoji / permission never blocks.
			safeLog("discord react failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const removeOwnReactions: DiscordConnection["removeOwnReactions"] = async (channel, messageId) => {
		try {
			const msg = await fetchMessage(channel, messageId);
			const cache = msg.reactions?.cache;
			const list: DiscordReactionLike[] = cache
				? cache instanceof Map
					? [...cache.values()]
					: [...(cache as Iterable<DiscordReactionLike>)]
				: [];
			const mine = list.filter((r) => r.me === true);
			// Nothing cached as ours → fall back to removeAll only if no other users'
			// reactions would be clobbered (we can't tell, so we DON'T removeAll here).
			for (const r of mine) {
				try {
					if (r.users?.remove) await r.users.remove(selfId ?? undefined);
					else if (r.remove) await r.remove();
				} catch (err) {
					safeLog("discord remove own reaction failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
				}
			}
		} catch (err) {
			safeLog("discord removeOwnReactions failed (cosmetic)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const registerCommands: DiscordConnection["registerCommands"] = async (commands) => {
		if (!commands || commands.length === 0) return;
		const c = client;
		const appId = selfId;
		const rest = c?.rest;
		if (!c || !appId || !rest || typeof rest.put !== "function") return;
		try {
			// Lazy-import Routes only on the production path; a test fake doesn't reach
			// here (no rest.put). The application-commands route is global.
			const discord = await import("discord.js");
			await rest.put(discord.Routes.applicationCommands(appId), { body: commands });
			safeLog("discord application commands registered", { count: commands.length });
		} catch (err) {
			safeLog("discord command registration failed (best-effort)", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	const setComposing: DiscordConnection["setComposing"] = async (channel, state) => {
		// Discord shows typing for ~10s or until the next message; we only fire it on
		// "composing" (there's no "stop typing" call). Best-effort + cosmetic.
		if (state !== "composing") return;
		try {
			const ch = await resolveSendChannel(channel);
			if (typeof ch.sendTyping === "function") await ch.sendTyping();
		} catch {
			/* cosmetic — missing permission / not live: ignore */
		}
	};

	const close: DiscordConnection["close"] = async () => {
		closed = true;
		connected = false;
		await teardownClient();
		try {
			await Promise.race([
				loopPromise ?? Promise.resolve(),
				new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
			]);
		} catch {
			/* loop already settled */
		}
	};

	return {
		selfId: () => selfId,
		selfName: () => selfName,
		connectedAt: () => connectedAtMs,
		lastEventAt: () => lastEventAtMs,
		isConnected: () => connected,
		isTokenInvalid: () => tokenInvalid,
		sendText,
		sendInteractive,
		sendMedia,
		react,
		removeOwnReactions,
		editMessageText,
		deleteMessage,
		pinMessage,
		unpinMessage,
		registerCommands,
		setComposing,
		markRead: async () => {},
		close,
	};
}

export { DISCORD_MESSAGE_LIMIT };
