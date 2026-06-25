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

/**
 * One sticker item on a message (`message.stickers` collection, or raw
 * `sticker_items`). Discord stickers carry an `id`, a `name`, and a
 * `format` / `format_type` enum (1=PNG, 2=APNG, 3=Lottie, 4=GIF) that selects
 * the CDN extension. We download them from `media.discordapp.net/stickers/<id>`.
 */
export interface DiscordStickerLike {
	id?: string;
	name?: string | null;
	/** discord.js exposes the enum as `format`; the raw gateway payload as `format_type`. */
	format?: number;
	format_type?: number;
	[key: string]: unknown;
}

/** One embed on a message (the subset Brigade folds into the assembled text). */
export interface DiscordEmbedLike {
	title?: string | null;
	description?: string | null;
	url?: string | null;
	[key: string]: unknown;
}

/**
 * A forwarded-message snapshot. Discord delivers a forward as a
 * `message_snapshots` array (raw) / `messageSnapshots` (discord.js Collection),
 * each wrapping a frozen copy of the original under `.message`. The snapshot
 * carries the original's content, embeds, attachments, stickers, and author.
 */
export interface DiscordSnapshotMessageLike {
	content?: string | null;
	embeds?: DiscordEmbedLike[] | null;
	attachments?: Iterable<DiscordAttachmentLike> | Map<string, DiscordAttachmentLike> | DiscordAttachmentLike[] | null;
	stickers?: Iterable<DiscordStickerLike> | Map<string, DiscordStickerLike> | DiscordStickerLike[] | null;
	sticker_items?: DiscordStickerLike[] | null;
	author?: { id?: string | null; username?: string | null; globalName?: string | null; global_name?: string | null } | null;
	[key: string]: unknown;
}

export interface DiscordSnapshotLike {
	message?: DiscordSnapshotMessageLike | null;
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
	/** Fetch a message in this channel by id (reply-parent fallback when `fetchReference` is absent). */
	messages?: { fetch?: (id: string) => Promise<DiscordMessageLike | null> };
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
	/**
	 * Reply / forward pointer. `messageId` is the referenced message; `type` is the
	 * reference KIND — `0` (default / absent) is a reply, `1` is a forward. discord.js
	 * also exposes the raw shape as `messageReference` with `type`.
	 */
	reference?: { messageId?: string | null; channelId?: string | null; guildId?: string | null; type?: number | null } | null;
	messageReference?: { messageId?: string | null; type?: number | null } | null;
	/**
	 * The resolved reply-parent message, when discord.js already cached it (it sends
	 * the referenced message inline with a Gateway MESSAGE_CREATE for a reply). Lets
	 * the reply-context resolve the parent's author SYNCHRONOUSLY — so a guild
	 * reply-to-bot is admitted even if the async body-backfill fetch later fails.
	 */
	referencedMessage?: DiscordMessageLike | null;
	/** First embed's title/description fold into the assembled text when content is empty. */
	embeds?: DiscordEmbedLike[] | null;
	/** Stickers on the message — a `<sticker: name>` placeholder + a downloaded asset. */
	stickers?: Iterable<DiscordStickerLike> | Map<string, DiscordStickerLike> | DiscordStickerLike[] | null;
	/** Raw gateway shape of the sticker list (fallback when `.stickers` is absent). */
	sticker_items?: DiscordStickerLike[] | null;
	/** Forwarded-message snapshots (discord.js Collection / raw array). */
	messageSnapshots?: Iterable<DiscordSnapshotLike> | Map<string, DiscordSnapshotLike> | DiscordSnapshotLike[] | null;
	message_snapshots?: DiscordSnapshotLike[] | null;
	attachments?: Iterable<DiscordAttachmentLike> | Map<string, DiscordAttachmentLike> | DiscordAttachmentLike[];
	/**
	 * discord.js `MessageType` enum value. `0` = Default, `19` = Reply; anything
	 * else is a SYSTEM message (a join / pin / boost / thread-created / …). Absent
	 * on a fake → treated as Default.
	 */
	type?: number;
	/** A resolved Collection of mentioned users, or a plain array on a fake. */
	mentions?: {
		users?: Iterable<DiscordUserLike> | Map<string, DiscordUserLike> | DiscordUserLike[];
	};
	/**
	 * Re-pull this message from the REST API (used to hydrate a late / proxied
	 * empty-content payload). discord.js returns the refreshed Message.
	 */
	fetch?: () => Promise<DiscordMessageLike>;
	/** Resolve the message this one replies to (discord.js `Message#fetchReference`). */
	fetchReference?: () => Promise<DiscordMessageLike | null>;
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

/* ───────────────────────── embeds / stickers / forwards (assembled text) ───────────────────────── */

const FORWARD_REFERENCE_TYPE = 1;

/**
 * True when the message is a FORWARD (reference kind `1`) rather than a reply
 * (kind `0` / absent). discord.js exposes the kind on `reference.type`; the raw
 * gateway shape carries it on `messageReference.type`. Used so a forward isn't
 * mistaken for a reply by the reply-context resolver.
 */
export function isDiscordForward(message: Pick<DiscordMessageLike, "reference" | "messageReference">): boolean {
	const t = message.reference?.type ?? message.messageReference?.type;
	return typeof t === "number" && t === FORWARD_REFERENCE_TYPE;
}

/** A short author label for a forwarded snapshot (globalName → username → id). */
function snapshotAuthorLabel(author: DiscordSnapshotMessageLike["author"]): string | undefined {
	if (!author) return undefined;
	const display = author.globalName ?? author.global_name ?? undefined;
	if (typeof display === "string" && display.trim()) return display.trim();
	const username = author.username;
	if (typeof username === "string" && username.trim()) return username.trim();
	return typeof author.id === "string" && author.id ? author.id : undefined;
}

/**
 * The first embed's text folded into a readable run: `title` + `description` +
 * (a bare `url` when neither carries it). Returns "" when the message has no
 * embed text. Pure + deterministic.
 */
export function extractDiscordEmbedText(message: Pick<DiscordMessageLike, "embeds">): string {
	const embed = Array.isArray(message.embeds) ? message.embeds[0] : undefined;
	if (!embed) return "";
	const title = typeof embed.title === "string" ? embed.title.trim() : "";
	const description = typeof embed.description === "string" ? embed.description.trim() : "";
	const url = typeof embed.url === "string" ? embed.url.trim() : "";
	const parts: string[] = [];
	if (title) parts.push(title);
	if (description) parts.push(description);
	// Surface the link only when there's no title/description carrying it already.
	if (url && parts.length === 0) parts.push(url);
	return parts.join("\n");
}

/** The sticker items on a message (the `.stickers` collection, then raw `sticker_items`). */
export function resolveInboundStickers(message: Pick<DiscordMessageLike, "stickers" | "sticker_items">): DiscordStickerLike[] {
	const fromCollection = toArray(message.stickers ?? undefined).filter((s): s is DiscordStickerLike => Boolean(s) && typeof s === "object");
	if (fromCollection.length > 0) return fromCollection;
	const raw = Array.isArray(message.sticker_items) ? message.sticker_items : [];
	return raw.filter((s): s is DiscordStickerLike => Boolean(s) && typeof s === "object");
}

/** A `<sticker: name>` placeholder line per sticker, joined by newlines. Returns "" when none. */
export function extractDiscordStickerText(message: Pick<DiscordMessageLike, "stickers" | "sticker_items">): string {
	const stickers = resolveInboundStickers(message);
	if (stickers.length === 0) return "";
	return stickers
		.map((s) => {
			const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : "sticker";
			return `<sticker: ${name}>`;
		})
		.join("\n");
}

/** The forwarded-message snapshots on a message (discord.js Collection or raw array). */
export function resolveDiscordSnapshots(message: Pick<DiscordMessageLike, "messageSnapshots" | "message_snapshots">): DiscordSnapshotLike[] {
	const fromCollection = toArray(message.messageSnapshots ?? undefined).filter((s): s is DiscordSnapshotLike => Boolean(s) && typeof s === "object");
	if (fromCollection.length > 0) return fromCollection;
	const raw = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
	return raw.filter((s): s is DiscordSnapshotLike => Boolean(s) && typeof s === "object");
}

/** The plain text of ONE forwarded snapshot's inner message (content → sticker → embed). */
function snapshotInnerText(snap: DiscordSnapshotMessageLike, resolve?: Parameters<typeof expandDiscordTokens>[1]): string {
	const content = typeof snap.content === "string" && !isBinaryContent(snap.content) ? expandDiscordTokens(snap.content, resolve).trim() : "";
	const stickerText = extractDiscordStickerText(snap);
	const embedText = extractDiscordEmbedText(snap);
	return content || stickerText || embedText || "";
}

/**
 * The `[Forwarded from <author>]` block(s) for any forwarded snapshots on the
 * message. Each snapshot becomes a heading + its inner text. A forward whose
 * snapshot has no text still surfaces the heading so the agent learns a forward
 * happened. Returns "" when the message carries no forward snapshots.
 */
export function extractDiscordForwardedText(
	message: Pick<DiscordMessageLike, "messageSnapshots" | "message_snapshots">,
	resolve?: Parameters<typeof expandDiscordTokens>[1],
): string {
	const snapshots = resolveDiscordSnapshots(message);
	if (snapshots.length === 0) return "";
	const blocks: string[] = [];
	for (const snap of snapshots) {
		const inner = snap.message ?? undefined;
		const author = inner ? snapshotAuthorLabel(inner.author) : undefined;
		const heading = author ? `[Forwarded from ${author}]` : "[Forwarded message]";
		const text = inner ? snapshotInnerText(inner, resolve) : "";
		blocks.push(text ? `${heading}\n${text}` : heading);
	}
	return blocks.join("\n\n");
}

/**
 * The full agent-facing text Brigade routes for a Discord message. The message
 * `content` leads (token-expanded); when content is empty we FALL BACK to the
 * first embed's title/description so an embed-only message isn't dropped. A
 * `<sticker: name>` placeholder is APPENDED for any stickers, and a
 * `[Forwarded from …]` block is APPENDED for any forwarded snapshots — so a
 * sticker-only or forward-only message carries real text instead of "".
 *
 * Pure + deterministic; the connection passes a `resolve` lookup so mention
 * tokens expand to readable names.
 */
export function assembleDiscordText(
	message: Pick<DiscordMessageLike, "content" | "embeds" | "stickers" | "sticker_items" | "messageSnapshots" | "message_snapshots">,
	resolve?: Parameters<typeof expandDiscordTokens>[1],
): string {
	const content = extractDiscordText(message, resolve);
	const parts: string[] = [];
	if (content) {
		parts.push(content);
	} else {
		const embedText = extractDiscordEmbedText(message);
		if (embedText) parts.push(embedText);
	}
	const stickerText = extractDiscordStickerText(message);
	if (stickerText) parts.push(stickerText);
	const forwardedText = extractDiscordForwardedText(message, resolve);
	if (forwardedText) parts.push(forwardedText);
	return parts.join("\n").trim();
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
 *
 * When discord.js already resolved the reply parent (`message.referencedMessage`,
 * which rides inline on a Gateway reply MESSAGE_CREATE), the parent's author id is
 * captured SYNCHRONOUSLY into `from`. This matters because the central pipeline's
 * group-addressing `isReplyToBot` depends on `replyTo.from === selfId` — if `from`
 * were populated ONLY by the async body-backfill (connection.ts), a guild
 * reply-to-bot whose backfill fetch failed would lose its implicit-mention
 * admission and be dropped. The async backfill still fills `body` (the excerpt).
 */
export function extractDiscordReplyContext(
	message: Pick<DiscordMessageLike, "reference" | "messageReference" | "referencedMessage">,
): InboundReplyContext | undefined {
	// A FORWARD (reference kind 1) also carries a `reference.messageId`, but it's a
	// forward — its content rides in the snapshot, not a quoted reply. Don't surface
	// it as reply context (the assembled text already carries the forwarded block).
	if (isDiscordForward(message)) return undefined;
	const ref = message.reference;
	const id = ref?.messageId;
	if (typeof id !== "string" || !id) return undefined;
	const out: InboundReplyContext = { messageId: id };
	// Synchronously resolve the parent author from the already-cached referenced
	// message when discord.js handed one — no async fetch needed.
	const parentAuthorId = message.referencedMessage?.author?.id;
	if (typeof parentAuthorId === "string" && parentAuthorId) out.from = parentAuthorId;
	return out;
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

/** discord.js sticker `format` / raw `format_type` enum: 1=PNG, 2=APNG, 3=Lottie, 4=GIF. */
const STICKER_FORMAT_PNG = 1;
const STICKER_FORMAT_APNG = 2;
const STICKER_FORMAT_LOTTIE = 3;
const STICKER_FORMAT_GIF = 4;

/** The CDN host stickers download from — already in the SSRF host allowlist (`media.discordapp.net`). */
const STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";

/**
 * The downloadable CDN URL + content-type for ONE sticker, derived from its
 * `format` enum. PNG/APNG → `.png`, GIF → `.gif`, Lottie (vector) → `.json`
 * (the raw Lottie animation; we don't rasterize). The host is `media.discordapp.net`,
 * already covered by the inbound SSRF allowlist. Returns null when the sticker
 * has no id.
 */
export function stickerToAttachment(sticker: DiscordStickerLike): DiscordAttachmentLike | null {
	const id = typeof sticker.id === "string" ? sticker.id.trim() : "";
	if (!id) return null;
	const format = typeof sticker.format === "number" ? sticker.format : typeof sticker.format_type === "number" ? sticker.format_type : STICKER_FORMAT_PNG;
	const baseName = typeof sticker.name === "string" && sticker.name.trim() ? sticker.name.trim().replace(/[^A-Za-z0-9_-]/g, "_") : `sticker-${id}`;
	let ext: string;
	let contentType: string;
	switch (format) {
		case STICKER_FORMAT_GIF:
			ext = "gif";
			contentType = "image/gif";
			break;
		case STICKER_FORMAT_LOTTIE:
			ext = "json";
			contentType = "application/json";
			break;
		case STICKER_FORMAT_APNG:
		case STICKER_FORMAT_PNG:
		default:
			ext = "png";
			contentType = "image/png";
			break;
	}
	return {
		id,
		name: `${baseName}.${ext}`,
		url: `${STICKER_ASSET_BASE_URL}/${id}.${ext}`,
		contentType,
	};
}

/** Sticker assets on a message, mapped to downloadable attachment descriptors. */
export function resolveInboundStickerAttachments(message: Pick<DiscordMessageLike, "stickers" | "sticker_items">): DiscordAttachmentLike[] {
	const out: DiscordAttachmentLike[] = [];
	for (const sticker of resolveInboundStickers(message)) {
		const att = stickerToAttachment(sticker);
		if (att) out.push(att);
	}
	return out;
}

/**
 * Downloadable attachments carried INSIDE forwarded snapshots (attachments +
 * stickers of each forwarded message). A forward arrives as a frozen snapshot,
 * so its media never appears on `message.attachments` — it has to be pulled out
 * of the snapshot.
 */
export function resolveForwardedAttachments(message: Pick<DiscordMessageLike, "messageSnapshots" | "message_snapshots">): DiscordAttachmentLike[] {
	const out: DiscordAttachmentLike[] = [];
	for (const snap of resolveDiscordSnapshots(message)) {
		const inner = snap.message;
		if (!inner) continue;
		for (const a of toArray(inner.attachments ?? undefined)) {
			if (isDownloadableAttachment(a)) out.push(a);
		}
		out.push(...resolveInboundStickerAttachments(inner));
	}
	return out;
}

/** The fields {@link hasInboundMedia} / {@link resolveInboundAttachments} read across the full media surface. */
type DiscordMediaSurface = Pick<DiscordMessageLike, "attachments" | "stickers" | "sticker_items" | "messageSnapshots" | "message_snapshots">;

/**
 * Cheap presence probe — does this message carry ANY downloadable media? Walks
 * direct attachments, stickers, AND forwarded-snapshot media but never touches
 * the network, so the connection layer can DEFER the actual download until AFTER
 * the central access gate admits the sender (mirrors Slack/Telegram).
 */
export function hasInboundMedia(message: DiscordMediaSurface): boolean {
	if (toArray(message.attachments).some(isDownloadableAttachment)) return true;
	if (resolveInboundStickers(message).length > 0) return true;
	if (resolveForwardedAttachments(message).length > 0) return true;
	return false;
}

/**
 * The full list of downloadable attachments to fetch for a message: direct
 * attachments, sticker assets (downloaded from the Discord sticker CDN), and any
 * media carried inside forwarded snapshots.
 */
export function resolveInboundAttachments(message: DiscordMediaSurface): DiscordAttachmentLike[] {
	const direct = toArray(message.attachments).filter(isDownloadableAttachment);
	const stickers = resolveInboundStickerAttachments(message);
	const forwarded = resolveForwardedAttachments(message);
	return [...direct, ...stickers, ...forwarded];
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
