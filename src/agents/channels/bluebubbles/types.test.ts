/**
 * Tests for the BlueBubbles REST transport's SSRF integration. Every REST call
 * goes through `blueBubblesFetchWithTimeout`, which routes through Brigade's SSRF
 * guard. A BlueBubbles server is normally a LAN host, so private networks are
 * allowed by default — but cloud-metadata stays blocked, and the operator can
 * tighten the knob to refuse private hosts entirely.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { blueBubblesFetchWithTimeout, SsrfBlockedError } from "./types.js";

/** A mock fetch that records the URL it was asked to hit and returns 200. */
function recordingFetch(seen: string[]): typeof fetch {
	return (async (url: string) => {
		seen.push(String(url));
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: { ok: true } }),
			arrayBuffer: async () => new ArrayBuffer(0),
			headers: new Headers(),
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("blueBubblesFetchWithTimeout — SSRF integration", () => {
	it("allows a private LAN host by default (allowPrivateNetwork defaults true)", async () => {
		const seen: string[] = [];
		const res = await blueBubblesFetchWithTimeout(
			"http://192.168.1.5:1234/api/v1/ping",
			{ method: "GET" },
			{ fetchImpl: recordingFetch(seen) },
		);
		assert.equal(res.status, 200);
		assert.equal(seen.length, 1, "the guard invoked the injected fetch for the allowed LAN host");
		assert.match(seen[0]!, /192\.168\.1\.5/);
	});

	it("blocks cloud-metadata even though private network is allowed", async () => {
		const seen: string[] = [];
		await assert.rejects(
			() =>
				blueBubblesFetchWithTimeout(
					"http://169.254.169.254/latest/meta-data/",
					{ method: "GET" },
					{ fetchImpl: recordingFetch(seen) },
				),
			(err: unknown) => err instanceof SsrfBlockedError,
		);
		assert.equal(seen.length, 0, "the wire call never fired for the metadata host");
	});

	it("blocks a private host when the operator tightens the knob (allowPrivateNetwork=false)", async () => {
		const seen: string[] = [];
		await assert.rejects(
			() =>
				blueBubblesFetchWithTimeout(
					"http://10.0.0.9:1234/api/v1/ping",
					{ method: "GET" },
					{ fetchImpl: recordingFetch(seen), allowPrivateNetwork: false },
				),
			(err: unknown) => err instanceof SsrfBlockedError,
		);
		assert.equal(seen.length, 0, "the wire call never fired for the refused private host");
	});
});
