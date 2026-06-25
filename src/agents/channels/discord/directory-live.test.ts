import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import { listDiscordDirectoryPeers, listDiscordDirectoryGroups } from "./directory-live.js";
import { listDiscordGuilds } from "./guilds.js";

const cfg = (): BrigadeConfig =>
	({ channels: { discord: { enabled: true, botToken: "tok-A.bbb.ccc" } } }) as unknown as BrigadeConfig;

/** Build a fetch fake that routes by URL substring → JSON body. */
function fakeFetch(routes: Array<{ match: string; body: unknown; ok?: boolean }>): typeof fetch {
	return (async (url: string) => {
		const u = String(url);
		const route = routes.find((r) => u.includes(r.match));
		if (!route) return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
		return {
			ok: route.ok !== false,
			status: route.ok === false ? 500 : 200,
			async json() {
				return route.body;
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("listDiscordGuilds", () => {
	it("returns id+name rows, skipping malformed entries", async () => {
		const fetchImpl = fakeFetch([
			{ match: "/users/@me/guilds", body: [{ id: "1", name: "Alpha" }, { id: "2" }, { name: "no-id" }] },
		]);
		const guilds = await listDiscordGuilds("tok", fetchImpl);
		assert.deepEqual(guilds, [{ id: "1", name: "Alpha" }]);
	});

	it("returns [] on a non-ok response", async () => {
		const fetchImpl = fakeFetch([{ match: "/users/@me/guilds", body: [], ok: false }]);
		assert.deepEqual(await listDiscordGuilds("tok", fetchImpl), []);
	});

	it("returns [] with no token", async () => {
		assert.deepEqual(await listDiscordGuilds("", fakeFetch([])), []);
	});
});

describe("listDiscordDirectoryGroups", () => {
	it("lists channels across guilds with #handles, skipping categories", async () => {
		const fetchImpl = fakeFetch([
			{ match: "/users/@me/guilds", body: [{ id: "g1", name: "G" }] },
			{
				match: "/guilds/g1/channels",
				body: [
					{ id: "c1", name: "general", type: 0 },
					{ id: "c2", name: "Category", type: 4 }, // skipped
					{ id: "c3", name: "random", type: 0 },
				],
			},
		]);
		const rows = await listDiscordDirectoryGroups({ cfg: cfg(), fetchImpl });
		assert.deepEqual(rows, [
			{ id: "channel:c1", name: "general", handle: "#general" },
			{ id: "channel:c3", name: "random", handle: "#random" },
		]);
	});

	it("query-filters + caps with limit", async () => {
		const fetchImpl = fakeFetch([
			{ match: "/users/@me/guilds", body: [{ id: "g1", name: "G" }] },
			{
				match: "/guilds/g1/channels",
				body: [
					{ id: "c1", name: "general", type: 0 },
					{ id: "c2", name: "random", type: 0 },
					{ id: "c3", name: "gen-2", type: 0 },
				],
			},
		]);
		const filtered = await listDiscordDirectoryGroups({ cfg: cfg(), fetchImpl, query: "gen" });
		assert.deepEqual(filtered.map((r) => r.id), ["channel:c1", "channel:c3"]);
		const capped = await listDiscordDirectoryGroups({ cfg: cfg(), fetchImpl, limit: 1 });
		assert.equal(capped.length, 1);
	});
});

describe("listDiscordDirectoryPeers", () => {
	it("lists members with @handles, ranking humans before bots", async () => {
		const fetchImpl = fakeFetch([
			{ match: "/users/@me/guilds", body: [{ id: "g1", name: "G" }] },
			{
				match: "/guilds/g1/members",
				body: [
					{ user: { id: "u1", username: "alex", global_name: "Alex" } },
					{ user: { id: "b1", username: "helperbot", bot: true } },
					{ user: { id: "u2", username: "sam" }, nick: "Sammy" },
				],
			},
		]);
		const rows = await listDiscordDirectoryPeers({ cfg: cfg(), fetchImpl });
		// Humans first (insertion order), then bots.
		assert.deepEqual(rows.map((r) => r.id), ["user:u1", "user:u2", "user:b1"]);
		assert.equal(rows[0]?.name, "Alex");
		assert.equal(rows[0]?.handle, "@alex");
		assert.equal(rows[1]?.name, "Sammy"); // nick wins
	});

	it("uses members/search when a query is given + filters client-side", async () => {
		let searchedUrl = "";
		const fetchImpl = (async (url: string) => {
			searchedUrl = String(url);
			if (searchedUrl.includes("/users/@me/guilds")) {
				return { ok: true, async json() { return [{ id: "g1", name: "G" }]; } } as unknown as Response;
			}
			return {
				ok: true,
				async json() {
					return [{ user: { id: "u1", username: "alex" } }];
				},
			} as unknown as Response;
		}) as unknown as typeof fetch;
		const rows = await listDiscordDirectoryPeers({ cfg: cfg(), fetchImpl, query: "ale" });
		assert.ok(searchedUrl.includes("/members/search"), "a query should hit members/search");
		assert.deepEqual(rows.map((r) => r.id), ["user:u1"]);
	});

	it("returns [] with no token", async () => {
		const empty = { channels: { discord: { enabled: true } } } as unknown as BrigadeConfig;
		assert.deepEqual(await listDiscordDirectoryPeers({ cfg: empty, fetchImpl: fakeFetch([]) }), []);
	});
});
