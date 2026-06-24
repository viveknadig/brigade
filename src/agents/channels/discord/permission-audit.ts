/**
 * Discord channel-permission audit — the #2 Discord footgun after the MESSAGE
 * CONTENT intent.
 *
 * A bot can be "connected" and still silently fail to post because its role
 * lacks `View Channel` + `Send Messages` in a specific channel (or a channel
 * permission OVERWRITE denies it). This module computes the bot's EFFECTIVE
 * permissions per channel the same way Discord does — base @everyone + the
 * bot's role permissions, then the channel's permission overwrites (deny then
 * allow, applied @everyone → roles → member) — and reports which channels are
 * missing the two required bits.
 *
 * Self-contained REST (no `discord.js`): `GET /channels/{id}` →
 * `GET /guilds/{guildId}` (roles) → `GET /guilds/{guildId}/members/{botId}`
 * (the bot's roles), plus a one-time `GET /users/@me` for the bot id. Injectable
 * fetch (tests stub it); never throws — a per-channel failure surfaces as an
 * `error` row, never an exception. Only NUMERIC ids are audited; a non-numeric
 * key is reported unresolved so the operator fixes the config.
 */

/** Discord permission bits (bigint). */
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_SEND_MESSAGES = 1n << 11n;

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Required permissions a bot needs to operate in a channel. */
const REQUIRED: Array<{ bit: bigint; name: string }> = [
	{ bit: PERM_VIEW_CHANNEL, name: "ViewChannel" },
	{ bit: PERM_SEND_MESSAGES, name: "SendMessages" },
];

/** Per-channel audit result. */
export interface DiscordChannelPermissionResult {
	channelId: string;
	/** True when the bot has every required bit (or Administrator). */
	ok: boolean;
	/** Required permission names the bot is MISSING (empty when ok). */
	missingRequired: string[];
	/** Best-effort error when the channel couldn't be evaluated. */
	error?: string;
}

/** Overall audit result. */
export interface DiscordPermissionAuditResult {
	channels: DiscordChannelPermissionResult[];
	/** Count of supplied ids that weren't numeric snowflakes (can't be audited). */
	unresolvedChannels: number;
}

interface PermissionOverwrite {
	id?: string;
	/** 0 = role overwrite, 1 = member overwrite. */
	type?: number;
	allow?: string;
	deny?: string;
}

interface ChannelObject {
	guild_id?: string;
	permission_overwrites?: PermissionOverwrite[];
}

interface RoleObject {
	id?: string;
	permissions?: string;
}

interface GuildObject {
	roles?: RoleObject[];
}

interface MemberObject {
	roles?: string[];
}

/** A numeric snowflake id (Discord ids are decimal strings). */
function isNumericId(value: string): boolean {
	return /^\d+$/.test(value.trim());
}

/** Apply an overwrite's deny then allow to a running permission bitfield. */
function applyOverwrite(perms: bigint, ow: PermissionOverwrite): bigint {
	let next = perms;
	if (ow.deny) {
		try {
			next &= ~BigInt(ow.deny);
		} catch {
			/* malformed bitstring — ignore */
		}
	}
	if (ow.allow) {
		try {
			next |= BigInt(ow.allow);
		} catch {
			/* malformed bitstring — ignore */
		}
	}
	return next;
}

/** Authenticated GET → parsed JSON object, or throws with a compact message. */
async function getJson<T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T> {
	const res = await fetchImpl(url, {
		method: "GET",
		headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

/**
 * Compute the bot's effective permission bitfield in one channel, mirroring
 * Discord's resolution order: base (@everyone role + the bot's roles), then
 * @everyone overwrite, then the bot's role overwrites, then the bot's member
 * overwrite. Administrator short-circuits to "all". Returns the bitfield.
 */
function computeEffectivePermissions(params: {
	botId: string;
	guildId: string;
	channel: ChannelObject;
	guild: GuildObject;
	member: MemberObject;
}): bigint {
	const { botId, guildId, channel, guild, member } = params;
	const rolesById = new Map<string, bigint>();
	for (const role of guild.roles ?? []) {
		if (typeof role.id !== "string") continue;
		let bits = 0n;
		try {
			bits = role.permissions ? BigInt(role.permissions) : 0n;
		} catch {
			bits = 0n;
		}
		rolesById.set(role.id, bits);
	}
	// Base = @everyone (role id === guildId) + each of the bot's roles.
	let perms = rolesById.get(guildId) ?? 0n;
	const memberRoleIds = Array.isArray(member.roles) ? member.roles : [];
	for (const roleId of memberRoleIds) {
		perms |= rolesById.get(roleId) ?? 0n;
	}
	// Administrator → all permissions, overwrites ignored.
	if ((perms & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR) {
		return ~0n;
	}
	const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
	// @everyone overwrite.
	for (const ow of overwrites) {
		if (ow.id === guildId) perms = applyOverwrite(perms, ow);
	}
	// The bot's role overwrites (accumulate allow/deny across them).
	let roleAllow = 0n;
	let roleDeny = 0n;
	for (const ow of overwrites) {
		if (ow.type === 0 && ow.id && memberRoleIds.includes(ow.id)) {
			try {
				if (ow.deny) roleDeny |= BigInt(ow.deny);
				if (ow.allow) roleAllow |= BigInt(ow.allow);
			} catch {
				/* ignore malformed */
			}
		}
	}
	perms &= ~roleDeny;
	perms |= roleAllow;
	// The bot's member overwrite (highest precedence).
	for (const ow of overwrites) {
		if (ow.id === botId) perms = applyOverwrite(perms, ow);
	}
	return perms;
}

/**
 * Audit the bot's `ViewChannel` + `SendMessages` in each supplied channel id.
 * Non-numeric ids are counted under `unresolvedChannels` and skipped (Discord
 * ids are numeric snowflakes — a name/slug key can't be resolved via REST). The
 * bot user id is fetched once via `/users/@me`. Best-effort + never throws.
 */
export async function auditDiscordChannelPermissions(
	token: string,
	channelIds: string[],
	fetchImpl: typeof fetch = fetch,
): Promise<DiscordPermissionAuditResult> {
	const clean = (token ?? "").trim();
	const ids = (channelIds ?? []).map((c) => (c ?? "").trim()).filter(Boolean);
	const numeric = ids.filter(isNumericId);
	const unresolvedChannels = ids.length - numeric.length;
	if (!clean || numeric.length === 0) {
		return { channels: [], unresolvedChannels };
	}
	// Resolve the bot user id once (needed for the member overwrite + member fetch).
	let botId = "";
	try {
		const me = await getJson<{ id?: string }>(`${DISCORD_API_BASE}/users/@me`, clean, fetchImpl);
		botId = typeof me?.id === "string" ? me.id : "";
	} catch {
		botId = "";
	}
	if (!botId) {
		return {
			channels: numeric.map((channelId) => ({
				channelId,
				ok: false,
				missingRequired: REQUIRED.map((r) => r.name),
				error: "could not resolve bot identity (/users/@me failed)",
			})),
			unresolvedChannels,
		};
	}
	const channels: DiscordChannelPermissionResult[] = [];
	for (const channelId of numeric) {
		try {
			const channel = await getJson<ChannelObject>(`${DISCORD_API_BASE}/channels/${channelId}`, clean, fetchImpl);
			const guildId = typeof channel.guild_id === "string" ? channel.guild_id : "";
			if (!guildId) {
				// A DM / group channel has no guild perms — treat as ok (the bot can
				// always send to a DM it can fetch).
				channels.push({ channelId, ok: true, missingRequired: [] });
				continue;
			}
			const [guild, member] = await Promise.all([
				getJson<GuildObject>(`${DISCORD_API_BASE}/guilds/${guildId}`, clean, fetchImpl),
				getJson<MemberObject>(`${DISCORD_API_BASE}/guilds/${guildId}/members/${botId}`, clean, fetchImpl),
			]);
			const perms = computeEffectivePermissions({ botId, guildId, channel, guild, member });
			const missingRequired = REQUIRED.filter((r) => (perms & r.bit) !== r.bit).map((r) => r.name);
			channels.push({ channelId, ok: missingRequired.length === 0, missingRequired });
		} catch (err) {
			channels.push({
				channelId,
				ok: false,
				missingRequired: REQUIRED.map((r) => r.name),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { channels, unresolvedChannels };
}
