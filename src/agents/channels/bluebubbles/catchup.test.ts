import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runBlueBubblesCatchup, BLUEBUBBLES_CATCHUP_MAX_LIMIT } from "./catchup.js";
import { connectBlueBubbles } from "./connection.js";
import type { ResolvedBlueBubblesAccount } from "./account-config.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "catchup", "pw"].join("-");

/** A fake fetch returning a canned message-query `data` array + recording the request body. */
function queryFetch(messages: unknown[], rec: { body: unknown }): typeof fetch {
	return (async (_url: string, init: RequestInit) => {
		if (typeof init.body === "string") {
			try {
				rec.body = JSON.parse(init.body);
			} catch {
				rec.body = init.body;
			}
		}
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: messages }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("runBlueBubblesCatchup", () => {
	it("queries message/query with a bounded after-window + limit and re-feeds each record", async () => {
		const rec: { body: unknown } = { body: null };
		const f = queryFetch([{ guid: "m1" }, { guid: "m2" }], rec);
		const fed: Array<Record<string, unknown>> = [];
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			feedRecord: (r) => fed.push(r),
			now: () => 1_000_000,
		});
		assert.equal(summary.querySucceeded, true);
		assert.equal(summary.fetched, 2);
		assert.equal(summary.replayed, 2);
		assert.equal(fed.length, 2);
		// The query carried `after` (the window start) + a sort + a limit.
		const body = rec.body as Record<string, unknown>;
		assert.equal(typeof body.after, "number");
		assert.equal(body.after, summary.windowStartMs);
		assert.equal(body.sort, "ASC");
		assert.equal(typeof body.limit, "number");
	});

	it("clamps the per-run limit to the hard ceiling", async () => {
		const rec: { body: unknown } = { body: null };
		const f = queryFetch([], rec);
		await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			config: { limit: 99_999 },
			feedRecord: () => {},
		});
		assert.equal((rec.body as Record<string, unknown>).limit, BLUEBUBBLES_CATCHUP_MAX_LIMIT);
	});

	it("is a no-op when disabled", async () => {
		let called = false;
		const f = (async () => {
			called = true;
			return { ok: true, status: 200, text: async () => "{}", headers: new Map() as unknown as Headers } as unknown as Response;
		}) as unknown as typeof fetch;
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			config: { enabled: false },
			feedRecord: () => {},
		});
		assert.equal(called, false);
		assert.equal(summary.querySucceeded, false);
	});

	it("never throws on a transport failure", async () => {
		const f = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			feedRecord: () => {},
		});
		assert.equal(summary.querySucceeded, false);
		assert.equal(summary.replayed, 0);
	});
});

/** Minimal resolved account for a connection-level catchup test. */
function account(fetchImpl: typeof fetch): ResolvedBlueBubblesAccount {
	return {
		accountId: "default",
		enabled: true,
		serverUrl: SERVER,
		password: PASSWORD,
		webhookPath: "/bluebubbles/webhook",
		region: "US",
		mediaMaxBytes: 100 * 1024 * 1024,
		probeTimeoutMs: 5000,
		actions: { reactions: true, edit: true, unsend: true, effects: true, groupAdmin: true },
		verbose: false,
	};
}

describe("catchup through the connection — dedupe prevents double-delivery", () => {
	it("a message already delivered live is NOT delivered again by catch-up", async () => {
		// The same message guid is delivered live AND comes back in the catch-up
		// query. The connection's dedupe cache must drop the replay.
		const liveMessage = {
			guid: "DUP-1",
			text: "hello",
			chatGuid: "iMessage;-;+15551234567",
			handle: { address: "+15551234567" },
			dateCreated: 1_000_000,
		};

		// Contact lookup + catch-up query share one fetch: route by URL.
		const f = (async (url: string, init: RequestInit) => {
			if (typeof url === "string" && url.includes("/message/query")) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ status: 200, data: [liveMessage] }),
					headers: new Map<string, string>() as unknown as Headers,
				} as unknown as Response;
			}
			// contact directory (empty) or anything else
			void init;
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data: [] }),
				headers: new Map<string, string>() as unknown as Headers,
			} as unknown as Response;
		}) as unknown as typeof fetch;

		const delivered: string[] = [];
		const conn = connectBlueBubbles({
			account: account(f),
			log: () => {},
			privateApi: true,
			fetchImpl: f,
			onMessage: (m) => delivered.push(m.messageGuid),
		});

		// Live delivery first.
		conn.feedWebhookEvent("new-message", { type: "new-message", data: liveMessage });
		// Let the async enrich+dispatch settle.
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(delivered.length, 1);

		// Now run catch-up — the same guid comes back and must be deduped away.
		const summary = await conn.runCatchup();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(summary.querySucceeded, true);
		assert.equal(summary.fetched, 1);
		// Still exactly one delivery — the replay was dropped at dedupe.
		assert.equal(delivered.length, 1);
		assert.deepEqual(delivered, ["DUP-1"]);
	});
});
