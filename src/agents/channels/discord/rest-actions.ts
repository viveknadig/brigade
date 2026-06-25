/**
 * Discord REST v10 action helpers — the self-contained REST surface behind the
 * `discord_action` agent tool.
 *
 * Mirrors `probe.ts`: every helper talks to `https://discord.com/api/v10/...`
 * over plain HTTPS with the `Authorization: Bot <token>` header — NO `discord.js`,
 * NO Gateway socket, NO live adapter/connection. The bot token is resolved by the
 * tool (via `resolveDiscordBotToken`) and threaded in; it rides only in the
 * `Authorization` header, built locally and never logged.
 *
 * `fetch` is INJECTABLE (defaults to global fetch) so tests can stub the call and
 * assert the exact METHOD + PATH + body without touching the network.
 *
 * The action surface here matches the guild capability set Brigade's live adapter
 * lacks: messaging/content (send, embeds, polls, stickers, reads, reactions,
 * threads, search), guild-admin (channels, categories, roles, members, emojis,
 * stickers, scheduled events), and moderation (ban/unban/kick/timeout). Each
 * helper returns the parsed Discord JSON (or `{ ok: true }` for empty 204s); REST
 * failures throw a {@link DiscordRestError} carrying the decoded Discord JSON code
 * so the tool can render an operator-readable message (permissions / 404 / rate
 * limit).
 */

import { stripBotPrefix } from "./account-config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 12_000;

/* ───────────────────────────── error decode ───────────────────────────── */

/**
 * Discord JSON error codes worth a tailored remediation hint. The numeric `code`
 * is the stable, documented Discord API error code (NOT the HTTP status) — it
 * survives across endpoints, so one decode table covers send + moderation +
 * guild-admin. Extends the Phase-2 `decodeDiscordSendError` set (50013 / 50007)
 * with the moderation + lookup codes this surface can hit.
 */
const DISCORD_ERROR_HINTS: Record<number, string> = {
	10003: "Unknown channel — the channel id doesn't exist or the bot can't see it.",
	10004: "Unknown guild — the bot isn't in that server, or the guild id is wrong.",
	10007: "Unknown member — that user isn't a member of the guild.",
	10008: "Unknown message — the message id is wrong or it was deleted.",
	10011: "Unknown role — the role id doesn't exist in that guild.",
	10013: "Unknown user — that user id doesn't exist.",
	10026: "Unknown ban — that user isn't banned (nothing to unban).",
	30005: "Maximum number of guild roles reached (250).",
	30007: "Maximum number of webhooks reached.",
	30008: "Maximum number of emojis reached for this guild's tier.",
	30013: "Maximum number of scheduled events reached.",
	50001: "Missing access — the bot can't see this channel/guild (invite it or grant View Channel).",
	50007: "Can't DM this user — they've blocked the bot or disabled DMs from server members.",
	50013: "The bot lacks the permission required for this action (check its role permissions + channel overrides).",
	50035: "Invalid form body — one of the supplied fields is malformed or out of range.",
	50045: "File uploaded exceeds the maximum size.",
};

/** A REST call that came back non-2xx. Carries the HTTP status + decoded Discord code. */
export class DiscordRestError extends Error {
	readonly status: number;
	/** The Discord JSON error `code` (stable across endpoints), when present. */
	readonly code?: number;
	/** Retry-after seconds, populated on a 429 rate-limit. */
	readonly retryAfter?: number;

	constructor(message: string, opts: { status: number; code?: number; retryAfter?: number }) {
		super(message);
		this.name = "DiscordRestError";
		this.status = opts.status;
		if (opts.code !== undefined) this.code = opts.code;
		if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
	}
}

/**
 * Turn a non-2xx Discord REST response into an operator-readable {@link DiscordRestError}.
 * Decodes the Discord JSON `code` into a remediation hint for the actionable cases
 * (permissions 50013, missing access 50001, DM-blocked 50007, unknown-resource
 * 100xx, rate-limit 429); everything else surfaces the raw Discord `message`.
 */
export function decodeDiscordRestError(status: number, body: unknown): DiscordRestError {
	const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const code = typeof record.code === "number" ? record.code : undefined;
	const apiMessage = typeof record.message === "string" ? record.message : undefined;
	if (status === 429) {
		const retryAfter =
			typeof record.retry_after === "number" ? record.retry_after : undefined;
		return new DiscordRestError(
			`Rate-limited by Discord${retryAfter !== undefined ? ` — retry after ${retryAfter}s` : ""}. Slow down and try again.`,
			{ status, ...(code !== undefined ? { code } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) },
		);
	}
	const hint = code !== undefined ? DISCORD_ERROR_HINTS[code] : undefined;
	const msg =
		hint ??
		(status === 404
			? "Discord returned 404 — the target resource (channel / message / user / guild) doesn't exist or isn't visible to the bot."
			: apiMessage
				? `Discord rejected the request (${apiMessage}${code !== undefined ? `, code ${code}` : ""}).`
				: `Discord request failed (HTTP ${status}${code !== undefined ? `, code ${code}` : ""}).`);
	return new DiscordRestError(msg, { status, ...(code !== undefined ? { code } : {}) });
}

/* ───────────────────────────── core request ───────────────────────────── */

/** Options every REST helper accepts: the resolved token + an injectable fetch. */
export interface DiscordRestOptions {
	/** The resolved bot token (Bot-prefix tolerated; stripped here). NEVER logged. */
	token: string;
	/** Injectable fetch — defaults to global fetch; tests pass a stub. */
	fetchImpl?: typeof fetch;
	/** Request timeout in ms (default 12s). */
	timeoutMs?: number;
}

interface RequestInput {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	/** Path under `/api/v10` (leading slash required), e.g. `/channels/123/messages`. */
	path: string;
	/** JSON body (object) — serialized + sent with a JSON content-type. Omit for GET/DELETE. */
	body?: unknown;
	/** Audit-log reason → `X-Audit-Log-Reason` header (moderation actions use it). */
	reason?: string;
	/** Query params appended to the path. */
	query?: Record<string, string | number | undefined>;
}

/**
 * Make one Discord REST call. Returns the parsed JSON (or `{ ok: true }` for an
 * empty 204). Non-2xx throws a decoded {@link DiscordRestError}. Aborts after
 * `timeoutMs`. The token rides only in the `Authorization` header.
 */
export async function discordRestRequest(
	input: RequestInput,
	opts: DiscordRestOptions,
): Promise<unknown> {
	const token = stripBotPrefix((opts.token ?? "").trim());
	if (!token) throw new Error("no Discord bot token configured");
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let url = `${DISCORD_API_BASE}${input.path}`;
	if (input.query) {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(input.query)) {
			if (v !== undefined && v !== null && `${v}` !== "") qs.append(k, String(v));
		}
		const s = qs.toString();
		if (s) url += `?${s}`;
	}

	const headers: Record<string, string> = {
		Authorization: `Bot ${token}`,
		"content-type": "application/json",
	};
	// X-Audit-Log-Reason must be Latin1/percent-encoded — a raw reason with an emoji,
	// accent, or newline (e.g. "spam 🚫", "Belästigung") makes `fetch` throw
	// `TypeError: invalid header value`, which would fail the whole moderation action.
	if (input.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(input.reason);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	try {
		const res = await doFetch(url, {
			method: input.method,
			headers,
			signal: controller.signal,
			...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
		});
		let parsed: unknown = null;
		if (res.status !== 204) {
			try {
				parsed = await res.json();
			} catch {
				parsed = null;
			}
		}
		if (!res.ok) throw decodeDiscordRestError(res.status, parsed);
		return res.status === 204 ? { ok: true } : parsed;
	} catch (err) {
		if (err instanceof DiscordRestError) throw err;
		if (controller.signal.aborted) throw new Error(`Discord request timed out after ${timeoutMs}ms`);
		throw err instanceof Error ? err : new Error(String(err));
	} finally {
		clearTimeout(timer);
	}
}

/* ───────────────────────────── shared shapes ───────────────────────────── */

/** A rich-embed spec the model can pass to `send` / `send-embed`. All fields optional. */
export interface DiscordEmbedSpec {
	title?: string;
	description?: string;
	/** Decimal color int (e.g. 0x5865f2 = 5793266). */
	color?: number;
	url?: string;
	fields?: Array<{ name: string; value: string; inline?: boolean }>;
	footer?: string;
	image?: string;
	thumbnail?: string;
}

/** Build a Discord embed object from a {@link DiscordEmbedSpec} (drops empty fields). */
export function buildEmbed(spec: DiscordEmbedSpec): Record<string, unknown> {
	const embed: Record<string, unknown> = {};
	if (spec.title) embed.title = spec.title;
	if (spec.description) embed.description = spec.description;
	if (typeof spec.color === "number" && Number.isFinite(spec.color)) embed.color = spec.color;
	if (spec.url) embed.url = spec.url;
	if (Array.isArray(spec.fields) && spec.fields.length > 0) {
		embed.fields = spec.fields
			.filter((f) => f && typeof f.name === "string" && typeof f.value === "string")
			.map((f) => ({ name: f.name, value: f.value, ...(f.inline ? { inline: true } : {}) }));
	}
	if (spec.footer) embed.footer = { text: spec.footer };
	if (spec.image) embed.image = { url: spec.image };
	if (spec.thumbnail) embed.thumbnail = { url: spec.thumbnail };
	return embed;
}

/**
 * Resolve a `to` target to a channel id for the messaging endpoints. A bare
 * snowflake is used directly as a channel id. A `user:<id>` target opens (or
 * reuses) a DM channel via `POST /users/@me/channels` and returns that id, so the
 * agent can DM a user by id without knowing the DM channel id. A `channel:<id>`
 * prefix is accepted and stripped.
 */
export async function resolveSendChannelId(to: string, opts: DiscordRestOptions): Promise<string> {
	const raw = (to ?? "").trim();
	if (!raw) throw new Error("a target channel id or user id is required");
	if (/^channel:/i.test(raw)) return raw.replace(/^channel:/i, "").trim();
	if (/^user:/i.test(raw)) {
		const userId = raw.replace(/^user:/i, "").trim();
		const dm = (await discordRestRequest(
			{ method: "POST", path: "/users/@me/channels", body: { recipient_id: userId } },
			opts,
		)) as { id?: string };
		if (!dm?.id) throw new Error(`couldn't open a DM channel with user ${userId}`);
		return dm.id;
	}
	return raw;
}

/* ───────────────────────── messaging / content ───────────────────────── */

/** SUPPRESS_NOTIFICATIONS message flag (1 << 12) — silences the @-ping. */
const DISCORD_SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

/**
 * The wire-shape `allowed_mentions` Discord expects (snake_case). Mirrors the
 * connection-path {@link safeDiscordAllowedMentions}: `parse` whitelists which
 * mention CLASSES notify; omitting `"everyone"` is what kills the `@everyone` /
 * `@here` mass-ping vector.
 */
export interface DiscordRestAllowedMentions {
	parse?: Array<"users" | "roles" | "everyone">;
	users?: string[];
	roles?: string[];
	replied_user?: boolean;
}

/**
 * The SAFE default `allowed_mentions` applied to every REST send body. Matches the
 * connection-path safety: `parse: ["users", "roles"]` lets explicit `<@id>` /
 * `<@&roleid>` mentions ping, while the absence of `"everyone"` means an
 * `@everyone` / `@here` that slipped into the content renders as inert text and
 * pings no one. A fresh object per call so a send can't mutate the shared default.
 */
export function safeRestAllowedMentions(): DiscordRestAllowedMentions {
	return { parse: ["users", "roles"] };
}

/**
 * Resolve the `allowed_mentions` for a REST send body. Defaults to the safe
 * everyone-excluding shape; an explicit caller override (opt-in) is passed through
 * verbatim so a deliberate, owner-authorized broadcast can still set `everyone`.
 */
function resolveRestAllowedMentions(
	override?: DiscordRestAllowedMentions,
): DiscordRestAllowedMentions {
	return override ?? safeRestAllowedMentions();
}

export async function sendMessage(
	params: {
		to: string;
		content?: string;
		embeds?: DiscordEmbedSpec[];
		components?: unknown[];
		replyTo?: string;
		silent?: boolean;
		/**
		 * Extra message flags to OR in (e.g. the Components-V2 flag 1<<15). The
		 * silent flag is added on top of these. A V2 message must NOT carry plain
		 * `content` — the caller moves text into TextDisplay blocks.
		 */
		flags?: number;
		/**
		 * Opt-in `allowed_mentions` override. Omit for the SAFE default (users + roles,
		 * NO everyone) so `@everyone` in `content` can't mass-ping; pass an explicit
		 * shape only for a deliberate, owner-authorized broadcast.
		 */
		allowedMentions?: DiscordRestAllowedMentions;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const channelId = await resolveSendChannelId(params.to, opts);
	const body: Record<string, unknown> = {};
	if (params.content) body.content = params.content;
	if (Array.isArray(params.embeds) && params.embeds.length > 0) {
		body.embeds = params.embeds.map((e) => buildEmbed(e));
	}
	if (Array.isArray(params.components) && params.components.length > 0) {
		body.components = params.components;
	}
	if (params.replyTo) body.message_reference = { message_id: params.replyTo };
	body.allowed_mentions = resolveRestAllowedMentions(params.allowedMentions);
	let flags = typeof params.flags === "number" && Number.isFinite(params.flags) ? params.flags : 0;
	if (params.silent) flags |= DISCORD_SUPPRESS_NOTIFICATIONS_FLAG;
	if (flags) body.flags = flags;
	if (body.content === undefined && !body.embeds && !body.components) {
		throw new Error("send requires content, embeds, or components");
	}
	return discordRestRequest(
		{ method: "POST", path: `/channels/${channelId}/messages`, body },
		opts,
	);
}

export async function sendEmbed(
	params: { to: string; embed: DiscordEmbedSpec; content?: string; allowedMentions?: DiscordRestAllowedMentions },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return sendMessage(
		{
			to: params.to,
			...(params.content ? { content: params.content } : {}),
			embeds: [params.embed],
			...(params.allowedMentions ? { allowedMentions: params.allowedMentions } : {}),
		},
		opts,
	);
}

export async function sendPoll(
	params: {
		to: string;
		question: string;
		answers: string[];
		durationHours?: number;
		allowMultiselect?: boolean;
		allowedMentions?: DiscordRestAllowedMentions;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const channelId = await resolveSendChannelId(params.to, opts);
	const answers = params.answers.slice(0, 10).map((text) => ({ poll_media: { text } }));
	const body: Record<string, unknown> = {
		poll: {
			question: { text: params.question },
			answers,
			duration: params.durationHours && params.durationHours > 0 ? params.durationHours : 24,
			allow_multiselect: params.allowMultiselect === true,
		},
		allowed_mentions: resolveRestAllowedMentions(params.allowedMentions),
	};
	return discordRestRequest(
		{ method: "POST", path: `/channels/${channelId}/messages`, body },
		opts,
	);
}

export async function sendSticker(
	params: { to: string; stickerIds: string[]; content?: string; allowedMentions?: DiscordRestAllowedMentions },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const channelId = await resolveSendChannelId(params.to, opts);
	const body: Record<string, unknown> = { sticker_ids: params.stickerIds.slice(0, 3) };
	if (params.content) body.content = params.content;
	body.allowed_mentions = resolveRestAllowedMentions(params.allowedMentions);
	return discordRestRequest(
		{ method: "POST", path: `/channels/${channelId}/messages`, body },
		opts,
	);
}

/** Fetch the most recent messages from a channel (capped at 50). */
export async function readMessages(
	params: { channelId: string; limit?: number; before?: string; after?: string; around?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const limit = Math.max(1, Math.min(50, params.limit ?? 25));
	return discordRestRequest(
		{
			method: "GET",
			path: `/channels/${params.channelId}/messages`,
			query: {
				limit,
				...(params.before ? { before: params.before } : {}),
				...(params.after ? { after: params.after } : {}),
				...(params.around ? { around: params.around } : {}),
			},
		},
		opts,
	);
}

/** Who reacted with a given emoji (capped at 50). `emoji` is the raw unicode or `name:id`. */
export async function listReactions(
	params: { channelId: string; messageId: string; emoji: string; limit?: number },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const limit = Math.max(1, Math.min(50, params.limit ?? 25));
	return discordRestRequest(
		{
			method: "GET",
			path: `/channels/${params.channelId}/messages/${params.messageId}/reactions/${encodeURIComponent(params.emoji)}`,
			query: { limit },
		},
		opts,
	);
}

/** Remove the bot's own reaction (or, with `userId`, another user's). */
export async function removeReaction(
	params: { channelId: string; messageId: string; emoji: string; userId?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const who = params.userId ? params.userId : "@me";
	return discordRestRequest(
		{
			method: "DELETE",
			path: `/channels/${params.channelId}/messages/${params.messageId}/reactions/${encodeURIComponent(params.emoji)}/${who}`,
		},
		opts,
	);
}

/** Create a thread — from a message (when `messageId` given) or standalone/forum. */
export async function threadCreate(
	params: {
		channelId: string;
		name: string;
		messageId?: string;
		autoArchiveMinutes?: number;
		type?: number;
		content?: string;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const body: Record<string, unknown> = { name: params.name };
	if (params.autoArchiveMinutes) body.auto_archive_duration = params.autoArchiveMinutes;
	if (params.messageId) {
		return discordRestRequest(
			{
				method: "POST",
				path: `/channels/${params.channelId}/messages/${params.messageId}/threads`,
				body,
			},
			opts,
		);
	}
	// Standalone / forum thread. Forum channels require a starter message.
	if (typeof params.type === "number") body.type = params.type;
	if (params.content) body.message = { content: params.content };
	return discordRestRequest(
		{ method: "POST", path: `/channels/${params.channelId}/threads`, body },
		opts,
	);
}

/** List active threads in a guild (active threads endpoint). */
export async function listThreads(
	params: { guildId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{ method: "GET", path: `/guilds/${params.guildId}/threads/active` },
		opts,
	);
}

/** Guild message search (capped at 25). */
export async function searchMessages(
	params: { guildId: string; query: string; authorId?: string; channelId?: string; limit?: number },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const limit = Math.max(1, Math.min(25, params.limit ?? 25));
	return discordRestRequest(
		{
			method: "GET",
			path: `/guilds/${params.guildId}/messages/search`,
			query: {
				content: params.query,
				limit,
				...(params.authorId ? { author_id: params.authorId } : {}),
				...(params.channelId ? { channel_id: params.channelId } : {}),
			},
		},
		opts,
	);
}

/* ───────────────────────────── guild-admin ───────────────────────────── */

export async function channelCreate(
	params: {
		guildId: string;
		name: string;
		type?: number;
		parentId?: string;
		topic?: string;
		position?: number;
		nsfw?: boolean;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const body: Record<string, unknown> = { name: params.name };
	if (typeof params.type === "number") body.type = params.type;
	if (params.parentId) body.parent_id = params.parentId;
	if (params.topic) body.topic = params.topic;
	if (typeof params.position === "number") body.position = params.position;
	if (typeof params.nsfw === "boolean") body.nsfw = params.nsfw;
	return discordRestRequest(
		{ method: "POST", path: `/guilds/${params.guildId}/channels`, body },
		opts,
	);
}

export async function channelEdit(
	params: {
		channelId: string;
		name?: string;
		topic?: string;
		position?: number;
		parentId?: string;
		nsfw?: boolean;
		rateLimitPerUser?: number;
		archived?: boolean;
		locked?: boolean;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const body: Record<string, unknown> = {};
	if (params.name !== undefined) body.name = params.name;
	if (params.topic !== undefined) body.topic = params.topic;
	if (typeof params.position === "number") body.position = params.position;
	if (params.parentId !== undefined) body.parent_id = params.parentId;
	if (typeof params.nsfw === "boolean") body.nsfw = params.nsfw;
	if (typeof params.rateLimitPerUser === "number") body.rate_limit_per_user = params.rateLimitPerUser;
	if (typeof params.archived === "boolean") body.archived = params.archived;
	if (typeof params.locked === "boolean") body.locked = params.locked;
	return discordRestRequest(
		{ method: "PATCH", path: `/channels/${params.channelId}`, body },
		opts,
	);
}

export async function channelDelete(
	params: { channelId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest({ method: "DELETE", path: `/channels/${params.channelId}` }, opts);
}

/** Move a channel (position + optional new parent) via the guild channel-positions endpoint. */
export async function channelMove(
	params: { guildId: string; channelId: string; position?: number; parentId?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const entry: Record<string, unknown> = { id: params.channelId };
	if (typeof params.position === "number") entry.position = params.position;
	if (params.parentId !== undefined) entry.parent_id = params.parentId;
	return discordRestRequest(
		{ method: "PATCH", path: `/guilds/${params.guildId}/channels`, body: [entry] },
		opts,
	);
}

/** Create a category (channel type 4). */
export async function categoryCreate(
	params: { guildId: string; name: string; position?: number },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return channelCreate(
		{ guildId: params.guildId, name: params.name, type: 4, ...(params.position !== undefined ? { position: params.position } : {}) },
		opts,
	);
}

export async function categoryEdit(
	params: { categoryId: string; name?: string; position?: number },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return channelEdit(
		{
			channelId: params.categoryId,
			...(params.name !== undefined ? { name: params.name } : {}),
			...(params.position !== undefined ? { position: params.position } : {}),
		},
		opts,
	);
}

export async function categoryDelete(
	params: { categoryId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return channelDelete({ channelId: params.categoryId }, opts);
}

export async function roleList(
	params: { guildId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest({ method: "GET", path: `/guilds/${params.guildId}/roles` }, opts);
}

export async function roleAdd(
	params: { guildId: string; userId: string; roleId: string; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{
			method: "PUT",
			path: `/guilds/${params.guildId}/members/${params.userId}/roles/${params.roleId}`,
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

export async function roleRemove(
	params: { guildId: string; userId: string; roleId: string; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{
			method: "DELETE",
			path: `/guilds/${params.guildId}/members/${params.userId}/roles/${params.roleId}`,
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

/** Alias of {@link roleList} — surfaced as the `role-info` action. */
export async function roleInfo(
	params: { guildId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return roleList(params, opts);
}

export async function memberInfo(
	params: { guildId: string; userId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{ method: "GET", path: `/guilds/${params.guildId}/members/${params.userId}` },
		opts,
	);
}

export async function emojiList(
	params: { guildId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest({ method: "GET", path: `/guilds/${params.guildId}/emojis` }, opts);
}

/** Upload a custom emoji. `image` MUST be a data URI (`data:image/png;base64,...`). */
export async function emojiUpload(
	params: { guildId: string; name: string; image: string; roleIds?: string[] },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const body: Record<string, unknown> = { name: params.name, image: params.image };
	if (params.roleIds && params.roleIds.length > 0) body.roles = params.roleIds;
	return discordRestRequest(
		{ method: "POST", path: `/guilds/${params.guildId}/emojis`, body },
		opts,
	);
}

/**
 * Upload a guild sticker. Discord requires `multipart/form-data` here (the sticker
 * file is a binary part), so this is the one helper that does NOT go through the
 * JSON `discordRestRequest`. `file` is the raw bytes; `contentType` is the
 * MIME type (image/png, image/apng, application/json for Lottie).
 */
export async function stickerUpload(
	params: {
		guildId: string;
		name: string;
		description: string;
		tags: string;
		file: Uint8Array;
		contentType: string;
		filename?: string;
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const token = stripBotPrefix((opts.token ?? "").trim());
	if (!token) throw new Error("no Discord bot token configured");
	const doFetch = opts.fetchImpl ?? fetch;
	const form = new FormData();
	form.append("name", params.name);
	form.append("description", params.description);
	form.append("tags", params.tags);
	form.append(
		"file",
		new Blob([params.file], { type: params.contentType }),
		params.filename ?? "sticker",
	);
	const res = await doFetch(`${DISCORD_API_BASE}/guilds/${params.guildId}/stickers`, {
		method: "POST",
		headers: { Authorization: `Bot ${token}` },
		body: form,
	});
	let parsed: unknown = null;
	if (res.status !== 204) {
		try {
			parsed = await res.json();
		} catch {
			parsed = null;
		}
	}
	if (!res.ok) throw decodeDiscordRestError(res.status, parsed);
	return parsed ?? { ok: true };
}

export async function eventList(
	params: { guildId: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{ method: "GET", path: `/guilds/${params.guildId}/scheduled-events` },
		opts,
	);
}

/**
 * Create a guild scheduled event. `entityType`: 1=stage, 2=voice, 3=external.
 * A voice/stage event needs `channelId`; an external event needs `location` +
 * `endTime`. Times are ISO-8601 strings.
 */
export async function eventCreate(
	params: {
		guildId: string;
		name: string;
		startTime: string;
		endTime?: string;
		description?: string;
		channelId?: string;
		location?: string;
		entityType?: "stage" | "voice" | "external";
	},
	opts: DiscordRestOptions,
): Promise<unknown> {
	const entityType = params.entityType === "stage" ? 1 : params.entityType === "external" ? 3 : 2;
	const body: Record<string, unknown> = {
		name: params.name,
		scheduled_start_time: params.startTime,
		entity_type: entityType,
		privacy_level: 2, // GUILD_ONLY
	};
	if (params.endTime) body.scheduled_end_time = params.endTime;
	if (params.description) body.description = params.description;
	if (params.channelId) body.channel_id = params.channelId;
	if (entityType === 3 && params.location) body.entity_metadata = { location: params.location };
	return discordRestRequest(
		{ method: "POST", path: `/guilds/${params.guildId}/scheduled-events`, body },
		opts,
	);
}

/* ───────────────────────────── moderation ───────────────────────────── */

/**
 * Ban a guild member. `deleteMessageDays` (0–7) purges their recent messages.
 * Owner-only is the tool gate; Discord enforces the bot's own BAN_MEMBERS
 * permission (a 50013 is decoded into a readable hint).
 */
export async function ban(
	params: { guildId: string; userId: string; reason?: string; deleteMessageDays?: number },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const body: Record<string, unknown> = {};
	if (typeof params.deleteMessageDays === "number") {
		const days = Math.max(0, Math.min(7, params.deleteMessageDays));
		body.delete_message_seconds = days * 86_400;
	}
	return discordRestRequest(
		{
			method: "PUT",
			path: `/guilds/${params.guildId}/bans/${params.userId}`,
			body,
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

export async function unban(
	params: { guildId: string; userId: string; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{
			method: "DELETE",
			path: `/guilds/${params.guildId}/bans/${params.userId}`,
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

export async function kick(
	params: { guildId: string; userId: string; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{
			method: "DELETE",
			path: `/guilds/${params.guildId}/members/${params.userId}`,
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

/**
 * Time a member out for `durationMinutes` from now (max 28 days), or clear it with
 * {@link untimeout}. Sets `communication_disabled_until` to an ISO timestamp.
 */
export async function timeout(
	params: { guildId: string; userId: string; durationMinutes: number; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	const MAX_MINUTES = 28 * 24 * 60;
	const minutes = Math.max(1, Math.min(MAX_MINUTES, params.durationMinutes));
	const until = new Date(Date.now() + minutes * 60_000).toISOString();
	return discordRestRequest(
		{
			method: "PATCH",
			path: `/guilds/${params.guildId}/members/${params.userId}`,
			body: { communication_disabled_until: until },
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}

/** Clear a member's timeout (sets `communication_disabled_until` to null). */
export async function untimeout(
	params: { guildId: string; userId: string; reason?: string },
	opts: DiscordRestOptions,
): Promise<unknown> {
	return discordRestRequest(
		{
			method: "PATCH",
			path: `/guilds/${params.guildId}/members/${params.userId}`,
			body: { communication_disabled_until: null },
			...(params.reason ? { reason: params.reason } : {}),
		},
		opts,
	);
}
