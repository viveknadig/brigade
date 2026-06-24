/**
 * Discord directory — operator-facing peer + channel listing for routing-config
 * (who/what can the bot be pointed at). Mirrors the SHAPE of
 * `slack/directory-live.ts`: standalone exported functions returning a flat
 * `{ id, name, handle }` shape, with NO central slot wiring (the cross-channel
 * directory slot is a separate effort — these are consumed directly by callers
 * for now).
 *
 * Brigade's existing `directory-cache.ts` is a per-message `id → display-name`
 * cache on the inbound hot path; it answers "what's THIS user's name" one id at
 * a time. This module answers the OTHER question an operator asks when wiring
 * routing: "list / search the people + channels this bot can see". It walks the
 * bot's guilds (`GET /users/@me/guilds`) and, per guild, pages members
 * (`GET /guilds/{id}/members/search?query=` when a query is set, else
 * `GET /guilds/{id}/members`) and channels (`GET /guilds/{id}/channels`).
 *
 * Token: reuses `resolveDiscordBotToken` (the bot token is Discord's only
 * credential). Network is injected (the `fetchImpl` seam) so this unit-tests
 * with a fake and never opens a socket unless actually called. Best-effort: a
 * failed guild call is skipped, returning whatever was collected.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { resolveDiscordBotToken, DISCORD_DEFAULT_ACCOUNT_ID } from "./account-config.js";
import { listDiscordGuilds } from "./guilds.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** A directory entry — a person (`user:<id>`) or a channel (`channel:<id>`). */
export interface DiscordDirectoryEntry {
	/** Stable addressable id (`user:<snowflake>` or `channel:<snowflake>`). */
	id: string;
	/** Human display name (nick / global name / username, or channel name). */
	name: string;
	/** Addressable handle (`@username` for a user, `#name` for a channel). Optional. */
	handle?: string;
}

/** One `GET /guilds/{id}/members[/search]` member object (the subset we read). */
interface DiscordMemberObject {
	user?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
	nick?: string | null;
}

/** One `GET /guilds/{id}/channels` channel object (the subset we read). */
interface DiscordChannelObject {
	id?: string;
	name?: string | null;
	type?: number;
}

/** Per-guild member cap so a huge guild can't dominate the result. */
const MEMBERS_PER_GUILD = 100;
/** Overall default cap when the caller omits `limit`. */
const DEFAULT_LIMIT = 50;

/** Common options for both directory queries. */
export interface DiscordDirectoryQuery {
	cfg: BrigadeConfig;
	/** Account scope; defaults to the single-account "default". */
	accountId?: string;
	/** Case-insensitive substring filter over name/handle. Empty → no filter. */
	query?: string;
	/** Cap the number of returned rows. Omitted/≤0 → a sane default. */
	limit?: number;
	/** Env for token resolution (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** TEST SEAM: inject fetch. Production uses global fetch. */
	fetchImpl?: typeof fetch;
}

/** Case-insensitive substring match; an empty query matches everything. */
function matchesQuery(query: string, ...candidates: Array<string | undefined>): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	return candidates.some((c) => typeof c === "string" && c.toLowerCase().includes(q));
}

/** Resolve the bot token for the directory account, or "" when unset. */
function resolveToken(q: DiscordDirectoryQuery): string {
	return resolveDiscordBotToken(q.cfg, q.accountId ?? DISCORD_DEFAULT_ACCOUNT_ID, q.env ?? process.env);
}

/** Authenticated GET → parsed JSON array, or `[]` on any failure (best-effort). */
async function getJsonArray<T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T[]> {
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
		});
		if (!res.ok) return [];
		const body = await res.json();
		return Array.isArray(body) ? (body as T[]) : [];
	} catch {
		return [];
	}
}

/**
 * List (and optionally filter) the PEOPLE the bot can see, walking each guild's
 * members. When a `query` is set the per-guild `members/search` endpoint is
 * used (server-side filter); otherwise the plain `members` listing is paged
 * once per guild (capped). Returns `{ id: "user:<id>", name, handle }` rows;
 * BOT accounts rank below humans so a picker surfaces people first. Best-effort.
 */
export async function listDiscordDirectoryPeers(q: DiscordDirectoryQuery): Promise<DiscordDirectoryEntry[]> {
	const token = resolveToken(q);
	if (!token) return [];
	const fetchImpl = q.fetchImpl ?? fetch;
	const query = (q.query ?? "").trim();
	const limit = typeof q.limit === "number" && q.limit > 0 ? q.limit : DEFAULT_LIMIT;
	const guilds = await listDiscordGuilds(token, fetchImpl);
	const seen = new Set<string>();
	const humans: DiscordDirectoryEntry[] = [];
	const bots: DiscordDirectoryEntry[] = [];
	for (const guild of guilds) {
		const url = query
			? `${DISCORD_API_BASE}/guilds/${guild.id}/members/search?${new URLSearchParams({
					query,
					limit: String(Math.min(limit, MEMBERS_PER_GUILD)),
				}).toString()}`
			: `${DISCORD_API_BASE}/guilds/${guild.id}/members?${new URLSearchParams({
					limit: String(MEMBERS_PER_GUILD),
				}).toString()}`;
		const members = await getJsonArray<DiscordMemberObject>(url, token, fetchImpl);
		for (const m of members) {
			const user = m.user;
			const userId = typeof user?.id === "string" ? user.id.trim() : "";
			if (!userId || seen.has(userId)) continue;
			const username = typeof user?.username === "string" ? user.username.trim() : "";
			const name =
				(typeof m.nick === "string" ? m.nick.trim() : "") ||
				(typeof user?.global_name === "string" ? user.global_name?.trim() : "") ||
				username ||
				userId;
			const handle = username ? `@${username}` : undefined;
			if (!matchesQuery(query, name, handle, userId)) continue;
			seen.add(userId);
			const row: DiscordDirectoryEntry = { id: `user:${userId}`, name, ...(handle ? { handle } : {}) };
			(user?.bot ? bots : humans).push(row);
		}
		if (humans.length + bots.length >= limit) break;
	}
	return [...humans, ...bots].slice(0, limit);
}

/**
 * List (and optionally filter) the CHANNELS the bot can see, walking each
 * guild's `channels`. Category channels (type 4) are skipped (they aren't a
 * send target). Returns `{ id: "channel:<id>", name, handle: "#name" }` rows.
 * Best-effort like {@link listDiscordDirectoryPeers}.
 */
export async function listDiscordDirectoryGroups(q: DiscordDirectoryQuery): Promise<DiscordDirectoryEntry[]> {
	const token = resolveToken(q);
	if (!token) return [];
	const fetchImpl = q.fetchImpl ?? fetch;
	const query = (q.query ?? "").trim();
	const limit = typeof q.limit === "number" && q.limit > 0 ? q.limit : DEFAULT_LIMIT;
	const guilds = await listDiscordGuilds(token, fetchImpl);
	const out: DiscordDirectoryEntry[] = [];
	const seen = new Set<string>();
	for (const guild of guilds) {
		const channels = await getJsonArray<DiscordChannelObject>(
			`${DISCORD_API_BASE}/guilds/${guild.id}/channels`,
			token,
			fetchImpl,
		);
		for (const c of channels) {
			const id = typeof c?.id === "string" ? c.id.trim() : "";
			const name = typeof c?.name === "string" ? c.name?.trim() : "";
			// Skip category containers (type 4) — not a message target.
			if (!id || !name || c?.type === 4 || seen.has(id)) continue;
			if (!matchesQuery(query, name, id)) continue;
			seen.add(id);
			out.push({ id: `channel:${id}`, name, handle: `#${name}` });
			if (out.length >= limit) return out;
		}
	}
	return out;
}
