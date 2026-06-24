import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { probeSlack } from "./probe.js";

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

describe("probeSlack", () => {
	it("returns ok + bot/team identity on a successful auth.test", async () => {
		const res = await probeSlack({
			token: "xoxb-AAA",
			fetchImpl: fakeFetch({
				json: { ok: true, user_id: "U42", user: "brigade", team_id: "T1", team: "Acme" },
			}),
		});
		assert.equal(res.ok, true);
		assert.equal(res.bot?.id, "U42");
		assert.equal(res.bot?.name, "brigade");
		assert.equal(res.team?.id, "T1");
		assert.equal(res.team?.name, "Acme");
	});

	it("returns ok:false with no token", async () => {
		const res = await probeSlack({ token: "" });
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /no Slack bot token/);
	});

	it("surfaces invalid_auth as a token-rejected error", async () => {
		const res = await probeSlack({
			token: "bad",
			fetchImpl: fakeFetch({ json: { ok: false, error: "invalid_auth" } }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /rejected the bot token/);
	});

	it("surfaces a generic Slack error code", async () => {
		const res = await probeSlack({
			token: "x",
			fetchImpl: fakeFetch({ json: { ok: false, error: "ratelimited" } }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /ratelimited/);
	});

	it("returns ok:false on a network error (never throws)", async () => {
		const res = await probeSlack({
			token: "xoxb-AAA",
			fetchImpl: fakeFetch({ throwErr: new Error("ECONNREFUSED") }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /ECONNREFUSED/);
	});
});
