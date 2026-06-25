/**
 * Discord REST action helper tests (Phase 4).
 *
 * Exercise a representative sample across each area (messaging, guild-admin,
 * moderation, reads) with an injected recording fetch that asserts the exact
 * METHOD + PATH + body Discord's REST v10 API expects — and confirm a 50013
 * permission error decodes into an operator-readable hint. No network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	DiscordRestError,
	ban,
	buildEmbed,
	channelCreate,
	decodeDiscordRestError,
	listReactions,
	readMessages,
	resolveSendChannelId,
	roleAdd,
	sendEmbed,
	sendMessage,
	sendPoll,
	sendSticker,
	timeout,
} from "./rest-actions.js";

/** A recording fake fetch: captures the call + returns a canned response. */
function recordFetch(opts?: {
	ok?: boolean;
	status?: number;
	json?: unknown;
	/** Return per-URL responses (e.g. DM-channel open then send). */
	route?: (url: string) => { ok: boolean; status: number; json: unknown } | undefined;
}): {
	fetch: typeof fetch;
	calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }>;
} {
	const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers as Record<string, string>) ?? {};
		let body: unknown;
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		calls.push({ url, method: init?.method ?? "GET", body, headers });
		const routed = opts?.route?.(url);
		if (routed) return { ok: routed.ok, status: routed.status, json: async () => routed.json } as Response;
		return {
			ok: opts?.ok ?? true,
			status: opts?.status ?? 200,
			json: async () => opts?.json ?? { id: "999" },
		} as Response;
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

const TOKEN = "AAA";

describe("rest-actions — messaging", () => {
	it("sendMessage POSTs to /channels/<id>/messages with content + Bot auth", async () => {
		const rec = recordFetch({ json: { id: "m1" } });
		await sendMessage({ to: "555", content: "hi there" }, { token: TOKEN, fetchImpl: rec.fetch });
		assert.equal(rec.calls.length, 1);
		const call = rec.calls[0]!;
		assert.equal(call.method, "POST");
		assert.match(call.url, /\/api\/v10\/channels\/555\/messages$/);
		assert.deepEqual(call.body, { content: "hi there", allowed_mentions: { parse: ["users", "roles"] } });
		assert.equal(call.headers.Authorization, "Bot AAA");
	});

	it("sendMessage with user:<id> opens a DM channel first, then posts to it", async () => {
		const rec = recordFetch({
			route: (url) => {
				if (url.endsWith("/users/@me/channels")) return { ok: true, status: 200, json: { id: "dm-channel-7" } };
				return { ok: true, status: 200, json: { id: "m2" } };
			},
		});
		await sendMessage({ to: "user:42", content: "dm" }, { token: TOKEN, fetchImpl: rec.fetch });
		assert.equal(rec.calls.length, 2);
		assert.match(rec.calls[0]!.url, /\/users\/@me\/channels$/);
		assert.deepEqual(rec.calls[0]!.body, { recipient_id: "42" });
		assert.match(rec.calls[1]!.url, /\/channels\/dm-channel-7\/messages$/);
	});

	it("sendEmbed sends an embeds[] array built from the spec", async () => {
		const rec = recordFetch();
		await sendEmbed(
			{ to: "555", embed: { title: "T", description: "D", color: 0x5865f2 } },
			{ token: TOKEN, fetchImpl: rec.fetch },
		);
		const body = rec.calls[0]!.body as { embeds: unknown[] };
		assert.equal(Array.isArray(body.embeds), true);
		assert.deepEqual(body.embeds[0], { title: "T", description: "D", color: 0x5865f2 });
	});

	it("sendPoll builds the poll body with answers + duration", async () => {
		const rec = recordFetch();
		await sendPoll(
			{ to: "555", question: "Best?", answers: ["A", "B"], durationHours: 12, allowMultiselect: true },
			{ token: TOKEN, fetchImpl: rec.fetch },
		);
		const body = rec.calls[0]!.body as { poll: Record<string, unknown> };
		assert.equal((body.poll.question as { text: string }).text, "Best?");
		assert.deepEqual(body.poll.answers, [{ poll_media: { text: "A" } }, { poll_media: { text: "B" } }]);
		assert.equal(body.poll.duration, 12);
		assert.equal(body.poll.allow_multiselect, true);
	});

	it("every REST send sets safe allowed_mentions (no everyone) — @everyone can't mass-ping (Bug 3)", async () => {
		const rec = recordFetch();
		// send with @everyone in content
		await sendMessage({ to: "555", content: "@everyone hi" }, { token: TOKEN, fetchImpl: rec.fetch });
		const sendBody = rec.calls[0]!.body as { allowed_mentions?: { parse?: string[] } };
		assert.deepEqual(sendBody.allowed_mentions, { parse: ["users", "roles"] });
		assert.ok(!sendBody.allowed_mentions?.parse?.includes("everyone"), "everyone must be excluded");

		// poll
		const recPoll = recordFetch();
		await sendPoll({ to: "555", question: "Q", answers: ["A"] }, { token: TOKEN, fetchImpl: recPoll.fetch });
		const pollBody = recPoll.calls[0]!.body as { allowed_mentions?: { parse?: string[] } };
		assert.deepEqual(pollBody.allowed_mentions, { parse: ["users", "roles"] });

		// sticker
		const recSticker = recordFetch();
		await sendSticker({ to: "555", stickerIds: ["s1"] }, { token: TOKEN, fetchImpl: recSticker.fetch });
		const stickerBody = recSticker.calls[0]!.body as { allowed_mentions?: { parse?: string[] } };
		assert.deepEqual(stickerBody.allowed_mentions, { parse: ["users", "roles"] });
	});

	it("an explicit allowedMentions override is passed through (opt-in broadcast)", async () => {
		const rec = recordFetch();
		await sendMessage(
			{ to: "555", content: "@everyone", allowedMentions: { parse: ["everyone"] } },
			{ token: TOKEN, fetchImpl: rec.fetch },
		);
		const body = rec.calls[0]!.body as { allowed_mentions?: { parse?: string[] } };
		assert.deepEqual(body.allowed_mentions, { parse: ["everyone"] });
	});

	it("readMessages GETs with a limit capped at 50", async () => {
		const rec = recordFetch({ json: [{ id: "a" }, { id: "b" }] });
		await readMessages({ channelId: "555", limit: 999 }, { token: TOKEN, fetchImpl: rec.fetch });
		const call = rec.calls[0]!;
		assert.equal(call.method, "GET");
		assert.match(call.url, /\/channels\/555\/messages\?limit=50$/);
	});

	it("listReactions GETs the reactions endpoint with the encoded emoji", async () => {
		const rec = recordFetch({ json: [] });
		await listReactions({ channelId: "555", messageId: "m1", emoji: "👍" }, { token: TOKEN, fetchImpl: rec.fetch });
		assert.match(rec.calls[0]!.url, /\/channels\/555\/messages\/m1\/reactions\/%F0%9F%91%8D\?limit=25$/);
	});
});

describe("rest-actions — guild-admin", () => {
	it("channelCreate POSTs to /guilds/<id>/channels with name + type", async () => {
		const rec = recordFetch({ json: { id: "c1", name: "general" } });
		await channelCreate({ guildId: "g1", name: "general", type: 0 }, { token: TOKEN, fetchImpl: rec.fetch });
		const call = rec.calls[0]!;
		assert.equal(call.method, "POST");
		assert.match(call.url, /\/guilds\/g1\/channels$/);
		assert.deepEqual(call.body, { name: "general", type: 0 });
	});

	it("roleAdd PUTs the member-role endpoint", async () => {
		const rec = recordFetch({ status: 204 });
		await roleAdd({ guildId: "g1", userId: "u1", roleId: "r1" }, { token: TOKEN, fetchImpl: rec.fetch });
		const call = rec.calls[0]!;
		assert.equal(call.method, "PUT");
		assert.match(call.url, /\/guilds\/g1\/members\/u1\/roles\/r1$/);
	});
});

describe("rest-actions — moderation", () => {
	it("ban PUTs /guilds/<id>/bans/<user> with delete_message_seconds + audit reason", async () => {
		const rec = recordFetch({ status: 204 });
		await ban(
			{ guildId: "g1", userId: "u1", reason: "spam", deleteMessageDays: 2 },
			{ token: TOKEN, fetchImpl: rec.fetch },
		);
		const call = rec.calls[0]!;
		assert.equal(call.method, "PUT");
		assert.match(call.url, /\/guilds\/g1\/bans\/u1$/);
		assert.deepEqual(call.body, { delete_message_seconds: 2 * 86_400 });
		assert.equal(call.headers["X-Audit-Log-Reason"], "spam");
	});

	it("a non-ASCII audit reason is percent-encoded so fetch can't throw on the header (Bug 1)", async () => {
		const rec = recordFetch({ status: 204 });
		// An emoji / accent / newline in a raw header value makes fetch throw
		// `TypeError: invalid header value`; encodeURIComponent makes it Latin1-safe.
		await ban(
			{ guildId: "g1", userId: "u1", reason: "spam 🚫 Belästigung" },
			{ token: TOKEN, fetchImpl: rec.fetch },
		);
		const header = rec.calls[0]!.headers["X-Audit-Log-Reason"];
		assert.equal(header, encodeURIComponent("spam 🚫 Belästigung"));
		// The header value must be pure ASCII (no raw multi-byte / control chars).
		assert.ok(/^[\x00-\x7F]*$/.test(header!), "encoded header is ASCII-safe");
	});

	it("timeout PATCHes the member with a future communication_disabled_until", async () => {
		const rec = recordFetch({ json: { user: { id: "u1" } } });
		const before = Date.now();
		await timeout({ guildId: "g1", userId: "u1", durationMinutes: 10 }, { token: TOKEN, fetchImpl: rec.fetch });
		const call = rec.calls[0]!;
		assert.equal(call.method, "PATCH");
		assert.match(call.url, /\/guilds\/g1\/members\/u1$/);
		const until = (call.body as { communication_disabled_until: string }).communication_disabled_until;
		assert.ok(new Date(until).getTime() > before, "timeout sets a future timestamp");
	});
});

describe("rest-actions — error decode", () => {
	it("decodeDiscordRestError maps 50013 to a missing-permission hint", () => {
		const err = decodeDiscordRestError(403, { code: 50013, message: "Missing Permissions" });
		assert.ok(err instanceof DiscordRestError);
		assert.equal(err.code, 50013);
		assert.match(err.message, /lacks the permission/i);
	});

	it("a 50013 response surfaces as a thrown DiscordRestError from a helper", async () => {
		const rec = recordFetch({ ok: false, status: 403, json: { code: 50013, message: "Missing Permissions" } });
		await assert.rejects(
			() => ban({ guildId: "g1", userId: "u1" }, { token: TOKEN, fetchImpl: rec.fetch }),
			(err: unknown) => err instanceof DiscordRestError && err.code === 50013 && /lacks the permission/i.test((err as Error).message),
		);
	});

	it("a 429 decodes into a rate-limit message carrying retryAfter", () => {
		const err = decodeDiscordRestError(429, { retry_after: 3.5 });
		assert.equal(err.status, 429);
		assert.equal(err.retryAfter, 3.5);
		assert.match(err.message, /rate-limited/i);
	});

	it("a 404 decodes into an unknown-resource message", () => {
		const err = decodeDiscordRestError(404, {});
		assert.match(err.message, /404/);
	});
});

describe("rest-actions — pure helpers", () => {
	it("buildEmbed drops empty fields + maps footer/image to objects", () => {
		const embed = buildEmbed({ title: "T", footer: "F", image: "https://x/y.png", fields: [{ name: "n", value: "v", inline: true }] });
		assert.deepEqual(embed, {
			title: "T",
			footer: { text: "F" },
			image: { url: "https://x/y.png" },
			fields: [{ name: "n", value: "v", inline: true }],
		});
	});

	it("resolveSendChannelId strips a channel: prefix without a network call", async () => {
		const rec = recordFetch();
		const id = await resolveSendChannelId("channel:123", { token: TOKEN, fetchImpl: rec.fetch });
		assert.equal(id, "123");
		assert.equal(rec.calls.length, 0);
	});
});
