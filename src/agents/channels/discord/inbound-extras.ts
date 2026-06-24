/**
 * Pure extractors that turn a discord.js message / reaction / interaction into
 * the normalized fields Brigade's `InboundMessage` carries. No network, no side
 * effects — every function here is deterministic over its argument so they're
 * trivial to unit-test without a live gateway.
 *
 * Discord's wire shape (rich discord.js objects, not raw JSON like Slack's
 * Events API) differs from Slack/Telegram in load-bearing ways, so the logic is
 * a Brigade-native re-implementation that models the SHAPE of
 * `slack/inbound-extras.ts` (raw payload → normalized signals) while speaking
 * Discord semantics:
 *
 *   - Text arrives as `message.content` peppered with Discord TOKENS: `<@123>`
 *     / `<@!123>` (user/member), `<@&456>` (role), `<#789>` (channel),
 *     `<:name:111>` / `<a:name:111>` (custom emoji). {@link extractDiscordText}
 *     expands user/channel/role mentions into readable plain text the agent can
 *     parse (`@alex`, `#general`), resolving names via an injected cache when one
 *     is supplied (the cached guild/client primes them in the background).
 *   - The bot is "addressed" when its own user id appears as a `<@123>` mention.
 *     {@link extractDiscordMentions} surfaces the bot's id when addressed so the
 *     central group ACL admits the message — exactly as Slack surfaces the bot's
 *     id. Every OTHER user mention is surfaced too.
 *   - Channel kind: a DM channel → `direct`; a guild text channel / thread →
 *     `group` (see {@link discordChannelType}).
 *   - Threads ride on the channel being a thread (`threadId` = the thread
 *     channel id); the parent text channel is the conversation root.
 *   - Reply context rides on `message.reference.messageId`.
 *   - Attachments arrive as `message.attachments` (each a CDN `url` + metadata);
 *     the connection layer DEFERS the byte download until the access gate admits
 *     the sender (mirrors Slack/Telegram's deferred-media discipline).
 *
 * Brigade's CENTRAL inbound pipeline owns the actual ACL / mention / routing
 * decision — these helpers only surface the raw signals it reads.
 */

import type { InboundReplyContext } from "../sdk.js";

/* ───────────────────────── structural shapes (the subset Brigade reads) ───────────────────────── */

/** One attachment discord.js exposes on a message (the subset we read). */
export interface DiscordAttachmentLike {
	id?: string;
	name?: string | null;
	/** CDN download URL (cdn.discordapp.com / media.discordapp.net). */
	url?: string;
	proxyURL?: string;
	contentType?: string | null;
	size?: number;
	/** Discord marks voice messages with this flag-bit set; we treat them as voice. */
	flags?: { has?: (bit: unknown) => boolean } | number;
	[key: string]: unknown;
}

/** A discord.js channel (the subset Brigade reads). `isThread()`/`isDMBased()` may be absent on a fake. */
export interface DiscordChannelLike {
	id?: string;
	/** Discord channel type enum value (0 = guild text, 1 = DM, 11/12 = thread, …). */
	type?: number;
	isThread?: () => boolean;
	isDMBased?: () => boolean;
	/** Parent text-channel id when this channel is a thread. */
	parentId?: string | null;
	[key: string]: unknown;
}

/** A discord.js guild (the subset Brigade reads). */
export interface DiscordGuildLike {
	id?: string;
	[key: string]: unknown;
}

/**
 * The member's roles as Brigade reads them. On a live message discord.js hands
 * a `GuildMemberRoleManager` whose `.cache` is a Collection (a Map subclass)
 * keyed by role id; a fake / partial may pass a plain array of role ids. Both
 * shapes (and an absent value) are honoured by {@link extractDiscordMemberRoleIds}.
 */
export type DiscordMemberRolesLike =
	| { cache?: Map<string, unknown> | Iterable<[string, unknown]> | Iterable<{ id?: string }> }
	| Iterable<string>
	| string[]
	| null
	| undefined;

/** A discord.js user / author (the subset Brigade reads). */
export interface DiscordUserLike {
	id?: string;
	bot?: boolean;
	username?: string;
	globalName?: string | null;
	/** Cached member display name (guild nickname), when discord.js resolved one. */
	displayName?: string;
	[key: string]: unknown;
}

/**
 * A discord.js Message (the subset Brigade consumes). Only the fields used are
 * typed; the live object carries far more.
 */
export interface DiscordMessageLike {
	id?: string;
	content?: string;
	author?: DiscordUserLike;
	/**
	 * The member who sent it (guild nickname lives here). `roles` is discord.js's
	 * `GuildMemberRoleManager` (a `.cache` Collection keyed by role id) on a live
	 * message; a fake / partial may instead carry a plain array of role ids.
	 */
	member?: { nickname?: string | null; displayName?: string; roles?: DiscordMemberRolesLike } | null;
	channelId?: string;
	channel?: DiscordChannelLike;
	guildId?: string | null;
	guild?: DiscordGuildLike | null;
	/** Epoch ms the message was created. */
	createdTimestamp?: number;
	/** Set when the message was edited (epoch ms), else null. */
	editedTimestamp?: number | null;
	/** Reply pointer — `messageId` is the message being replied to. */
	reference?: { messageId?: string | null; channelId?: string | null; guildId?: string | null } | null;
	attachments?: Iterable<DiscordAttachmentLike> | Map<string, DiscordAttachmentLike> | DiscordAttachmentLike[];
	/** A resolved Collection of mentioned users, or a plain array on a fake. */
	mentions?: {
		users?: Iterable<DiscordUserLike> | Map<string, DiscordUserLike> | DiscordUserLike[];
	};
	[key: string]: unknown;
}

/* ───────────────────────── small helpers ───────────────────────── */

/**
 * Reject control-byte payloads (a binary blob masquerading as text). Tab / LF /
 * CR are allowed; any other C0 control char marks the run as non-text and it's
 * dropped so the agent never ingests raw binary. Mirrors Slack's
 * `isBinaryContent`.
 */
function isBinaryContent(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
	}
	return false;
}

/** Normalize a discord.js Collection / Map / iterable / array into a plain array. */
function toArray<T>(coll: Iterable<T> | Map<string, T> | T[] | undefined | null): T[] {
	if (!coll) return [];
	if (Array.isArray(coll)) return coll;
	if (coll instanceof Map) return [...coll.values()];
	// A discord.js Collection extends Map, so the branch above catches it; this is
	// the generic-iterable fallback for any other shape.
	if (typeof (coll as Iterable<T>)[Symbol.iterator] === "function") return [...(coll as Iterable<T>)];
	return [];
}

/* ───────────────────────── token expansion ───────────────────────── */

/**
 * Expand the Discord message TOKENS in a run of text into readable plain text:
 *   - `<@123>` / `<@!123>`     → `@alex` (resolved name) or `@123`
 *   - `<@&456>`                → `@role` (resolved) or `@&456`
 *   - `<#789>`                 → `#general` (resolved) or `#789`
 *   - `<:name:111>` / `<a:name:111>` → `:name:` (the readable emoji shortcode)
 *
 * Names resolve via the injected lookups (the connection primes them from the
 * cached guild/client); without a resolver the bare id is surfaced. Pure +
 * deterministic.
 */
export function expandDiscordTokens(
	text: string,
	resolve?: {
		user?: (id: string) => string | undefined;
		role?: (id: string) => string | undefined;
		channel?: (id: string) => string | undefined;
	},
): string {
	if (!text) return "";
	return text.replace(/<(a?):([A-Za-z0-9_]{2,32}):\d+>|<@&(\d+)>|<@!?(\d+)>|<#(\d+)>/g, (whole, _anim, emojiName, roleId, userId, channelId) => {
		if (typeof emojiName === "string" && emojiName) return `:${emojiName}:`;
		if (typeof roleId === "string" && roleId) {
			const name = resolve?.role?.(roleId);
			return name ? `@${name}` : `@&${roleId}`;
		}
		if (typeof userId === "string" && userId) {
			const name = resolve?.user?.(userId);
			return name ? `@${name}` : `@${userId}`;
		}
		if (typeof channelId === "string" && channelId) {
			const name = resolve?.channel?.(channelId);
			return name ? `#${name}` : `#${channelId}`;
		}
		return whole as string;
	});
}

/**
 * The agent-facing plain text of a Discord message. Token-expanded (mentions /
 * channels / roles / emoji → readable text). Binary blobs are dropped to "".
 */
export function extractDiscordText(
	message: Pick<DiscordMessageLike, "content">,
	resolve?: Parameters<typeof expandDiscordTokens>[1],
): string {
	const raw = typeof message.content === "string" ? message.content : "";
	if (!raw || isBinaryContent(raw)) return "";
	return expandDiscordTokens(raw, resolve).trim();
}

/* ───────────────────────── chat type + thread + reply ───────────────────────── */

/** Discord channel-type enum values Brigade distinguishes. */
const CHANNEL_TYPE_DM = 1;
const CHANNEL_TYPE_GROUP_DM = 3;
const THREAD_TYPE_VALUES = new Set([10, 11, 12]); // announcement / public / private thread

/** True when a discord.js channel is a thread (uses `isThread()` when present, else the type enum). */
export function isThreadChannel(channel: DiscordChannelLike | undefined | null): boolean {
	if (!channel) return false;
	if (typeof channel.isThread === "function") return channel.isThread();
	return typeof channel.type === "number" && THREAD_TYPE_VALUES.has(channel.type);
}

/** True when a discord.js channel is a DM (uses `isDMBased()` when present, else the type enum). */
export function isDmChannel(channel: DiscordChannelLike | undefined | null): boolean {
	if (!channel) return false;
	if (typeof channel.isDMBased === "function") return channel.isDMBased();
	return channel.type === CHANNEL_TYPE_DM || channel.type === CHANNEL_TYPE_GROUP_DM;
}

/**
 * Discord channel → Brigade chat type. A 1:1 DM → `direct`; a guild text channel
 * or a thread → `group`. A group DM (rare for bots) → `group`. When no channel
 * object is available, a missing `guildId` implies a DM.
 */
export function discordChannelType(message: Pick<DiscordMessageLike, "channel" | "guildId">): "direct" | "group" {
	const channel = message.channel;
	if (channel) {
		if (isDmChannel(channel) && channel.type !== CHANNEL_TYPE_GROUP_DM) return "direct";
		return "group";
	}
	// No channel object: a message with no guild is a DM.
	return message.guildId ? "group" : "direct";
}

/**
 * The thread channel id when the message landed in a thread, else undefined. The
 * thread's own channel id is the thread id (Discord threads ARE channels).
 */
export function discordThreadId(message: Pick<DiscordMessageLike, "channel" | "channelId">): string | undefined {
	const channel = message.channel;
	if (channel && isThreadChannel(channel)) {
		return typeof channel.id === "string" ? channel.id : typeof message.channelId === "string" ? message.channelId : undefined;
	}
	return undefined;
}

/**
 * Reply-context (what message this inbound quotes), when it's a reply. Discord
 * carries `message.reference.messageId` (the replied-to message id) but does NOT
 * inline that message's text — so the context surfaces the parent message id and
 * leaves `body` undefined (the connection can fetch the parent if it needs the
 * excerpt). Returns undefined for a non-reply.
 */
export function extractDiscordReplyContext(message: Pick<DiscordMessageLike, "reference">): InboundReplyContext | undefined {
	const ref = message.reference;
	const id = ref?.messageId;
	if (typeof id !== "string" || !id) return undefined;
	return { messageId: id };
}

/* ───────────────────────── mentions ───────────────────────── */

/**
 * Channel-native ids of users addressed in this message. Brigade's central group
 * ACL treats a group message as "addressed to the bot" when the bot's own id
 * appears in `mentions`; without this a group message never reaches the agent.
 * So when the bot's own `<@id>` mention appears in the text we surface the bot's
 * id (passed in). Every OTHER user mention is surfaced too so the pipeline sees
 * who else was tagged.
 *
 * We scan BOTH the resolved `message.mentions.users` collection (when present)
 * AND the raw `<@id>` / `<@!id>` tokens in the content, unioned + deduped — the
 * collection is authoritative on a live message, the token scan is the fallback
 * for a fake / a partial.
 *
 * @param botUserId the bot's own user id, surfaced when the bot is mentioned so
 *                  the ACL admits the group message.
 */
export function extractDiscordMentions(message: DiscordMessageLike, botUserId?: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let botMentioned = false;
	const push = (id: string | undefined) => {
		if (!id || seen.has(id)) return;
		if (botUserId && id === botUserId) {
			botMentioned = true;
			return; // the bot's own id is pushed LAST (after the addressed check)
		}
		seen.add(id);
		out.push(id);
	};

	for (const u of toArray(message.mentions?.users)) {
		if (typeof u?.id === "string") push(u.id);
	}
	const content = typeof message.content === "string" ? message.content : "";
	const re = /<@!?(\d+)>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		if (m[1]) push(m[1]);
	}

	if (botMentioned && botUserId) {
		out.push(botUserId);
	}
	return out;
}

/**
 * The guild-role ids the sending member holds, surfaced so the 8-tier route
 * resolver's `binding.guild+roles` tier can match. Role NAMES are never used —
 * only ids. Returns `[]` for a DM (no member) or when no roles resolve.
 *
 * Handles the three shapes the `member.roles` value can take:
 *   - discord.js `GuildMemberRoleManager` — a `.cache` Collection (Map subclass)
 *     keyed by role id; we read the keys (the role ids).
 *   - a plain array / iterable of role-id strings (a fake / partial).
 *   - absent / null (a DM, or a message with no resolved member) → `[]`.
 *
 * Pure + deterministic; deduped, with the `@everyone` role (whose id equals the
 * guild id and is implicit for everyone) left in as-is — the resolver only
 * matches ids a binding explicitly lists, so a stray everyone id is harmless.
 */
export function extractDiscordMemberRoleIds(message: Pick<DiscordMessageLike, "member">): string[] {
	const roles = message.member?.roles;
	if (!roles) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (id: unknown): void => {
		if (typeof id !== "string") return;
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push(trimmed);
	};

	// Plain string array / iterable of ids (a fake or a partial).
	if (Array.isArray(roles)) {
		for (const id of roles) push(id);
		return out;
	}

	// A `GuildMemberRoleManager` exposes `.cache` (a Collection ⊂ Map keyed by id).
	const cache = (roles as { cache?: unknown }).cache;
	if (cache) {
		if (cache instanceof Map) {
			for (const key of cache.keys()) push(key);
			return out;
		}
		if (typeof (cache as Iterable<unknown>)[Symbol.iterator] === "function") {
			// A Collection iterates `[key, value]` pairs; a bare value-iterable yields
			// role-ish objects. Read the id off whichever shape arrives.
			for (const item of cache as Iterable<unknown>) {
				if (Array.isArray(item)) push(item[0]);
				else if (item && typeof item === "object" && "id" in item) push((item as { id?: unknown }).id);
				else push(item);
			}
			return out;
		}
	}

	// A bare iterable of ids on the manager itself (some fakes).
	if (typeof (roles as Iterable<unknown>)[Symbol.iterator] === "function") {
		for (const id of roles as Iterable<unknown>) push(id);
	}
	return out;
}

/**
 * A short display name for the sender. A guild nickname wins (most specific),
 * then the member/global display name, then the username, then the raw id.
 */
export function buildDiscordSenderName(message: DiscordMessageLike): string | undefined {
	const nickname = message.member?.nickname;
	if (typeof nickname === "string" && nickname.trim()) return nickname.trim();
	const memberDisplay = message.member?.displayName;
	if (typeof memberDisplay === "string" && memberDisplay.trim()) return memberDisplay.trim();
	const author = message.author;
	const display = author?.displayName ?? author?.globalName;
	if (typeof display === "string" && display.trim()) return display.trim();
	const username = author?.username;
	if (typeof username === "string" && username.trim()) return username.trim();
	return typeof author?.id === "string" ? author.id : undefined;
}

/* ───────────────────────── media detection ───────────────────────── */

/** The Discord voice-message flag bit (1 << 13). discord.js exposes `flags.has(...)`; we also accept the raw number. */
const VOICE_MESSAGE_FLAG = 1 << 13;

/** A downloadable attachment is one carrying a url. */
function isDownloadableAttachment(a: DiscordAttachmentLike): boolean {
	return Boolean(a && (a.url || a.proxyURL));
}

/**
 * Cheap presence probe — does this message carry a downloadable attachment?
 * Walks `message.attachments` but never touches the network, so the connection
 * layer can DEFER the actual download until AFTER the central access gate admits
 * the sender (mirrors Slack/Telegram). Mirrors `hasInboundMedia`.
 */
export function hasInboundMedia(message: Pick<DiscordMessageLike, "attachments">): boolean {
	return toArray(message.attachments).some(isDownloadableAttachment);
}

/** The list of downloadable attachments on a message. */
export function resolveInboundAttachments(message: Pick<DiscordMessageLike, "attachments">): DiscordAttachmentLike[] {
	return toArray(message.attachments).filter(isDownloadableAttachment);
}

/** True when an attachment carries the Discord voice-message flag. */
function isVoiceAttachment(a: DiscordAttachmentLike): boolean {
	const flags = a.flags;
	if (typeof flags === "number") return (flags & VOICE_MESSAGE_FLAG) !== 0;
	if (flags && typeof flags.has === "function") {
		try {
			return Boolean(flags.has(VOICE_MESSAGE_FLAG));
		} catch {
			return false;
		}
	}
	return false;
}

/** The Brigade media-kind of a Discord attachment, from its contentType / filename / voice flag. */
export function resolveDiscordAttachmentKind(a: DiscordAttachmentLike): "image" | "video" | "audio" | "voice" | "document" {
	if (isVoiceAttachment(a)) return "voice";
	const mime = (a.contentType ?? "").toLowerCase();
	const name = (a.name ?? "").toLowerCase();
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
	if (mime.startsWith("image/") || /^(png|jpg|jpeg|gif|webp|bmp|heic)$/.test(ext)) return "image";
	if (mime.startsWith("video/") || /^(mp4|mov|webm|mkv|avi)$/.test(ext)) return "video";
	if (mime.startsWith("audio/") || /^(mp3|m4a|ogg|wav|flac|aac)$/.test(ext)) {
		return ext === "ogg" || ext === "m4a" ? "voice" : "audio";
	}
	return "document";
}
