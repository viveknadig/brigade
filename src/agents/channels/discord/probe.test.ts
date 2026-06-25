import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decodeMessageContentIntent, decodePrivilegedIntents, MESSAGE_CONTENT_DISABLED_WARNING, probeDiscord } from "./probe.js";

// Application-flag bits (Discord's actual values).
const FLAG_PRESENCE = 1 << 12;
const FLAG_GUILD_MEMBERS = 1 << 14;
const FLAG_GUILD_MEMBERS_LIMITED = 1 << 15;
const FLAG_MESSAGE_CONTENT = 1 << 18;

/** Build a fake fetch returning a canned response. */
function fakeFetch(opts: { ok?: boolean; status?: number; json?: unknown; throwErr?: Error }): typeof fetch {
	return (async () => {
		if (opts.throwErr) throw opts.throwErr;
		return {
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			json: async () => opts.json,
		} as Response;
	}) as unknown as typeof fetch;
}

/**
 * A URL-aware fake fetch: `/users/@me` returns the identity body; the
 * application-flags endpoint returns `appFlags` (or throws / 403 when asked).
 * Lets the MESSAGE CONTENT intent probe be exercised independently of identity.
 */
function fakeFetchWithFlags(opts: {
	meJson?: unknown;
	appFlags?: number;
	appThrows?: boolean;
	appNotOk?: boolean;
}): typeof fetch {
	return (async (url: string) => {
		if (typeof url === "string" && url.includes("/oauth2/applications/@me")) {
			if (opts.appThrows) throw new Error("flags fetch boom");
			if (opts.appNotOk) return { ok: false, status: 403, json: async () => ({}) } as Response;
			return { ok: true, status: 200, json: async () => ({ flags: opts.appFlags }) } as Response;
		}
		return { ok: true, status: 200, json: async () => opts.meJson ?? { id: "1", username: "bot" } } as Response;
	}) as unknown as typeof fetch;
}

describe("probeDiscord", () => {
	it("returns ok + bot identity on a successful /users/@me", async () => {
		const res = await probeDiscord({
			token: "AAA",
			fetchImpl: fakeFetch({ json: { id: "123", username: "brigadebot", discriminator: "0" } }),
		});
		assert.equal(res.ok, true);
		assert.equal(res.bot?.id, "123");
		assert.equal(res.bot?.name, "brigadebot");
		// Discriminator "0" (post-migration) is omitted.
		assert.equal(res.bot?.discriminator, undefined);
	});

	it("returns ok:false with no token", async () => {
		const res = await probeDiscord({ token: "" });
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /no Discord bot token/);
	});

	it("strips a `Bot ` prefix before probing", async () => {
		let seenAuth: string | undefined;
		await probeDiscord({
			token: "Bot AAA",
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return { ok: true, status: 200, json: async () => ({ id: "1" }) } as Response;
			}) as unknown as typeof fetch,
		});
		// The resolver strips `Bot `, then probe re-adds exactly one `Bot ` prefix.
		assert.equal(seenAuth, "Bot AAA");
	});

	it("surfaces a 401 as a token-rejected error", async () => {
		const res = await probeDiscord({
			token: "bad",
			fetchImpl: fakeFetch({ ok: false, status: 401, json: { message: "401: Unauthorized", code: 0 } }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /rejected the bot token/);
	});

	it("surfaces a generic non-401 error", async () => {
		const res = await probeDiscord({
			token: "x",
			fetchImpl: fakeFetch({ ok: false, status: 429, json: { message: "rate limited" } }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /rate limited/);
	});

	it("returns ok:false on a network error (never throws)", async () => {
		const res = await probeDiscord({
			token: "AAA",
			fetchImpl: fakeFetch({ throwErr: new Error("ECONNREFUSED") }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /ECONNREFUSED/);
	});
});

describe("decodeMessageContentIntent", () => {
	it("decodes the MESSAGE CONTENT bit (1<<18) as enabled", () => {
		assert.equal(decodeMessageContentIntent(1 << 18), "enabled");
		assert.equal(decodeMessageContentIntent((1 << 18) | 1), "enabled");
	});

	it("decodes the LIMITED bit (1<<19) as limited", () => {
		assert.equal(decodeMessageContentIntent(1 << 19), "limited");
	});

	it("decodes neither bit set as disabled", () => {
		assert.equal(decodeMessageContentIntent(0), "disabled");
		assert.equal(decodeMessageContentIntent(1 << 17), "disabled");
	});

	it("returns undefined for a non-number (flags unavailable)", () => {
		assert.equal(decodeMessageContentIntent(undefined), undefined);
		assert.equal(decodeMessageContentIntent(null), undefined);
		assert.equal(decodeMessageContentIntent("12"), undefined);
	});
});

describe("probeDiscord — MESSAGE CONTENT intent (Fix 3)", () => {
	it("reports enabled when the application flag is set", async () => {
		const res = await probeDiscord({ token: "AAA", fetchImpl: fakeFetchWithFlags({ appFlags: 1 << 18 }) });
		assert.equal(res.ok, true);
		assert.equal(res.messageContentIntent, "enabled");
		assert.equal(res.messageContentWarning, undefined);
	});

	it("reports disabled + surfaces the warning when the flag is clear", async () => {
		const res = await probeDiscord({ token: "AAA", fetchImpl: fakeFetchWithFlags({ appFlags: 0 }) });
		assert.equal(res.ok, true);
		assert.equal(res.messageContentIntent, "disabled");
		assert.equal(res.messageContentWarning, MESSAGE_CONTENT_DISABLED_WARNING);
		assert.match(res.messageContentWarning ?? "", /MESSAGE CONTENT intent/);
	});

	it("still succeeds (intent undefined) when the flags fetch errors — best-effort", async () => {
		const res = await probeDiscord({ token: "AAA", fetchImpl: fakeFetchWithFlags({ appThrows: true }) });
		assert.equal(res.ok, true);
		assert.equal(res.messageContentIntent, undefined);
		assert.equal(res.messageContentWarning, undefined);
	});

	it("still succeeds (intent undefined) when the flags fetch is non-ok", async () => {
		const res = await probeDiscord({ token: "AAA", fetchImpl: fakeFetchWithFlags({ appNotOk: true }) });
		assert.equal(res.ok, true);
		assert.equal(res.messageContentIntent, undefined);
	});
});

describe("decodePrivilegedIntents (Phase 5)", () => {
	it("decodes all three intents from flags", () => {
		// message content enabled (1<<18), guild members limited (1<<15), presence disabled.
		const flags = FLAG_MESSAGE_CONTENT | FLAG_GUILD_MEMBERS_LIMITED;
		const intents = decodePrivilegedIntents(flags);
		assert.deepEqual(intents, { messageContent: "enabled", guildMembers: "limited", presence: "disabled" });
	});

	it("all enabled", () => {
		const flags = FLAG_MESSAGE_CONTENT | FLAG_GUILD_MEMBERS | FLAG_PRESENCE;
		assert.deepEqual(decodePrivilegedIntents(flags), {
			messageContent: "enabled",
			guildMembers: "enabled",
			presence: "enabled",
		});
	});

	it("all disabled when no bits set", () => {
		assert.deepEqual(decodePrivilegedIntents(0), {
			messageContent: "disabled",
			guildMembers: "disabled",
			presence: "disabled",
		});
	});

	it("non-number flags → undefined", () => {
		assert.equal(decodePrivilegedIntents(undefined), undefined);
		assert.equal(decodePrivilegedIntents("nope"), undefined);
	});

	it("probeDiscord surfaces the full privilegedIntents decode", async () => {
		const res = await probeDiscord({
			token: "AAA",
			fetchImpl: fakeFetchWithFlags({ appFlags: FLAG_MESSAGE_CONTENT | FLAG_GUILD_MEMBERS }),
		});
		assert.equal(res.ok, true);
		assert.deepEqual(res.privilegedIntents, {
			messageContent: "enabled",
			guildMembers: "enabled",
			presence: "disabled",
		});
		// Back-compat field still set.
		assert.equal(res.messageContentIntent, "enabled");
	});
});
