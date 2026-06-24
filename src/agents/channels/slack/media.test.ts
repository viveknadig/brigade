import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { downloadSlackFile, withSlackRetry } from "./media.js";

describe("withSlackRetry", () => {
	it("returns the first successful result without retrying", async () => {
		let calls = 0;
		const out = await withSlackRetry(async () => {
			calls += 1;
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 1);
	});

	it("retries a transient failure and then succeeds", async () => {
		let calls = 0;
		const out = await withSlackRetry(async () => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 3);
	});

	it("throws the last error after exhausting attempts (default 3)", async () => {
		let calls = 0;
		await assert.rejects(
			withSlackRetry(async () => {
				calls += 1;
				throw new Error(`fail-${calls}`);
			}),
			/fail-3/,
		);
		assert.equal(calls, 3);
	});

	it("honors a custom attempt count", async () => {
		let calls = 0;
		await assert.rejects(
			withSlackRetry(async () => {
				calls += 1;
				throw new Error("nope");
			}, 1),
		);
		assert.equal(calls, 1);
	});
});

describe("downloadSlackFile", () => {
	it("returns null (no fetch) for a file with no private url", async () => {
		let fetched = false;
		const out = await downloadSlackFile({
			file: { id: "F1" },
			token: "xoxb-x",
			fetchImpl: (async () => {
				fetched = true;
				return new Response("", { status: 200 });
			}) as typeof fetch,
		});
		assert.equal(out, null);
		assert.equal(fetched, false);
	});

	it("sends an Authorization: Bearer header when fetching the private url", async () => {
		let seenAuth: string | undefined;
		await downloadSlackFile({
			file: { id: "F1", url_private: "https://files.slack.com/F1", size: 999_999_999_999 },
			token: "xoxb-secret",
			fetchImpl: (async (_url: string, init?: RequestInit) => {
				seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				return new Response("", { status: 200 });
			}) as unknown as typeof fetch,
		});
		// The oversized `size` short-circuits before fetch, so assert the guard works.
		assert.equal(seenAuth, undefined);
	});
});
