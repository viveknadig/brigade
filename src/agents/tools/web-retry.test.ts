/**
 * Tests for `fetchWithRetry` — retry semantics, Retry-After honoring,
 * AbortSignal propagation. Pure-logic; no network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fetchWithRetry } from "./web-retry.js";

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response("", { status, headers });
}

describe("fetchWithRetry — retry conditions", () => {
	it("returns immediately on 2xx", async () => {
		let calls = 0;
		const r = await fetchWithRetry(() => {
			calls += 1;
			return Promise.resolve(makeResponse(200));
		});
		assert.equal(r.status, 200);
		assert.equal(calls, 1);
	});

	it("retries on 429 until cap is hit", async () => {
		let calls = 0;
		const r = await fetchWithRetry(
			() => {
				calls += 1;
				return Promise.resolve(makeResponse(429));
			},
			{ maxAttempts: 3, baseDelayMs: 1 },
		);
		assert.equal(r.status, 429);
		assert.equal(calls, 3);
	});

	it("retries on 503 then succeeds on 200", async () => {
		let calls = 0;
		const r = await fetchWithRetry(
			() => {
				calls += 1;
				return Promise.resolve(makeResponse(calls < 2 ? 503 : 200));
			},
			{ maxAttempts: 3, baseDelayMs: 1 },
		);
		assert.equal(r.status, 200);
		assert.equal(calls, 2);
	});

	it("does NOT retry on 4xx (except 429)", async () => {
		let calls = 0;
		const r = await fetchWithRetry(
			() => {
				calls += 1;
				return Promise.resolve(makeResponse(403));
			},
			{ maxAttempts: 3, baseDelayMs: 1 },
		);
		assert.equal(r.status, 403);
		assert.equal(calls, 1);
	});

	it("honors Retry-After integer-seconds header", async () => {
		let calls = 0;
		const startedAt = Date.now();
		const r = await fetchWithRetry(
			() => {
				calls += 1;
				return Promise.resolve(
					calls < 2 ? makeResponse(429, { "retry-after": "1" }) : makeResponse(200),
				);
			},
			{ maxAttempts: 2, baseDelayMs: 1 },
		);
		const elapsed = Date.now() - startedAt;
		assert.equal(r.status, 200);
		assert.equal(calls, 2);
		// Roughly 1s wait — accept slack for scheduling jitter.
		assert.ok(elapsed >= 800, `expected wait >= 800ms, got ${elapsed}`);
	});

	it("retries transient network errors via isTransient", async () => {
		let calls = 0;
		const r = await fetchWithRetry(
			() => {
				calls += 1;
				if (calls < 2) {
					const e = new Error("fetch failed") as Error & { code: string };
					e.code = "ECONNRESET";
					throw e;
				}
				return Promise.resolve(makeResponse(200));
			},
			{ maxAttempts: 3, baseDelayMs: 1 },
		);
		assert.equal(r.status, 200);
		assert.equal(calls, 2);
	});

	it("aborts loop when signal aborts", async () => {
		const ctl = new AbortController();
		setTimeout(() => ctl.abort(new Error("user-cancel")), 5);
		await assert.rejects(
			fetchWithRetry(
				() => Promise.resolve(makeResponse(429)),
				{ maxAttempts: 100, baseDelayMs: 50, signal: ctl.signal },
			),
		);
	});
});
