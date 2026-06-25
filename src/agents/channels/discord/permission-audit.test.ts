import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { auditDiscordChannelPermissions } from "./permission-audit.js";

const VIEW = 1n << 10n; // ViewChannel
const SEND = 1n << 11n; // SendMessages
const ADMIN = 1n << 3n; // Administrator

/**
 * Build a fetch fake for the audit's calls: /users/@me, /channels/{id},
 * /guilds/{id}, /guilds/{id}/members/{botId}. Each channel is described by its
 * everyone-role perms + the bot member's role perms + optional overwrites.
 */
function fakeAuditFetch(opts: {
	botId?: string;
	channels: Record<
		string,
		{
			guildId?: string;
			everyonePerms: bigint;
			botRolePerms?: bigint;
			overwrites?: Array<{ id: string; type?: number; allow?: bigint; deny?: bigint }>;
			notFound?: boolean;
		}
	>;
}): typeof fetch {
	const botId = opts.botId ?? "BOT";
	return (async (url: string) => {
		const u = String(url);
		const ok = (body: unknown) => ({ ok: true, status: 200, async json() { return body; } }) as unknown as Response;
		const fail = (status: number) => ({ ok: false, status, async json() { return {}; } }) as unknown as Response;
		if (u.endsWith("/users/@me")) return ok({ id: botId });
		const chMatch = /\/channels\/([^/]+)$/.exec(u);
		if (chMatch) {
			const ch = opts.channels[chMatch[1]!];
			if (!ch || ch.notFound) return fail(404);
			return ok({
				guild_id: ch.guildId ?? "G1",
				permission_overwrites: (ch.overwrites ?? []).map((o) => ({
					id: o.id,
					type: o.type ?? 0,
					allow: o.allow ? o.allow.toString() : "0",
					deny: o.deny ? o.deny.toString() : "0",
				})),
			});
		}
		const memberMatch = /\/guilds\/([^/]+)\/members\/([^/]+)$/.exec(u);
		if (memberMatch) {
			// Find which channel this guild belongs to (single-guild fakes here).
			const ch = Object.values(opts.channels)[0]!;
			return ok({ roles: ch.botRolePerms !== undefined ? ["botrole"] : [] });
		}
		const guildMatch = /\/guilds\/([^/]+)$/.exec(u);
		if (guildMatch) {
			const guildId = guildMatch[1]!;
			const ch = Object.values(opts.channels).find((c) => (c.guildId ?? "G1") === guildId)!;
			const roles = [{ id: guildId, permissions: ch.everyonePerms.toString() }];
			if (ch.botRolePerms !== undefined) roles.push({ id: "botrole", permissions: ch.botRolePerms.toString() });
			return ok({ roles });
		}
		return fail(404);
	}) as unknown as typeof fetch;
}

describe("auditDiscordChannelPermissions", () => {
	it("ok when the bot has View + Send via @everyone", async () => {
		const fetchImpl = fakeAuditFetch({ channels: { "100": { everyonePerms: VIEW | SEND } } });
		const result = await auditDiscordChannelPermissions("tok", ["100"], fetchImpl);
		assert.equal(result.channels[0]?.ok, true);
		assert.deepEqual(result.channels[0]?.missingRequired, []);
	});

	it("flags a channel missing SendMessages", async () => {
		const fetchImpl = fakeAuditFetch({ channels: { "100": { everyonePerms: VIEW } } });
		const result = await auditDiscordChannelPermissions("tok", ["100"], fetchImpl);
		assert.equal(result.channels[0]?.ok, false);
		assert.deepEqual(result.channels[0]?.missingRequired, ["SendMessages"]);
	});

	it("Administrator short-circuits to all-permissions", async () => {
		const fetchImpl = fakeAuditFetch({ channels: { "100": { everyonePerms: 0n, botRolePerms: ADMIN } } });
		const result = await auditDiscordChannelPermissions("tok", ["100"], fetchImpl);
		assert.equal(result.channels[0]?.ok, true);
	});

	it("a channel overwrite that denies SendMessages is honored", async () => {
		const fetchImpl = fakeAuditFetch({
			channels: { "100": { everyonePerms: VIEW | SEND, overwrites: [{ id: "G1", deny: SEND }] } },
		});
		const result = await auditDiscordChannelPermissions("tok", ["100"], fetchImpl);
		assert.equal(result.channels[0]?.ok, false);
		assert.deepEqual(result.channels[0]?.missingRequired, ["SendMessages"]);
	});

	it("counts non-numeric channel ids as unresolved + skips them", async () => {
		const fetchImpl = fakeAuditFetch({ channels: { "100": { everyonePerms: VIEW | SEND } } });
		const result = await auditDiscordChannelPermissions("tok", ["100", "general", "my-channel"], fetchImpl);
		assert.equal(result.unresolvedChannels, 2);
		assert.equal(result.channels.length, 1);
	});

	it("a fetch error surfaces as an error row, not a throw", async () => {
		const fetchImpl = fakeAuditFetch({ channels: { "100": { everyonePerms: 0n, notFound: true } } });
		const result = await auditDiscordChannelPermissions("tok", ["100"], fetchImpl);
		assert.equal(result.channels[0]?.ok, false);
		assert.ok(result.channels[0]?.error);
	});
});
