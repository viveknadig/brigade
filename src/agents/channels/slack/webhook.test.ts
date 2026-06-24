import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	buildSlackWebhookRoute,
	parseSlackBody,
	SLACK_SIGNATURE_HEADER,
	SLACK_TIMESTAMP_HEADER,
	verifySlackSignature,
} from "./webhook.js";

const SECRET = "shhh-signing-secret";

/** Compute a valid Slack `v0=` signature for a body at a timestamp. */
function sign(rawBody: string, ts: string): string {
	const base = `v0:${ts}:${rawBody}`;
	return `v0=${createHmac("sha256", SECRET).update(base).digest("hex")}`;
}

/**
 * Minimal fake request. By default it STREAMS the body (the out-of-gateway
 * path). With `preBuffered: true` it instead attaches the body to `req.body`
 * (mirroring the gateway dispatcher, which drains + buffers the stream before
 * the route runs) and emits NO stream events — so a handler that re-reads the
 * stream would hang. This lets the tests exercise both paths.
 */
function fakeReq(opts: { method?: string; headers?: Record<string, string>; body?: string; preBuffered?: boolean }): EventEmitter & {
	method?: string;
	headers: Record<string, string | string[] | undefined>;
	body?: Buffer;
} {
	const req = new EventEmitter() as EventEmitter & { method?: string; headers: Record<string, string | string[] | undefined>; body?: Buffer };
	req.method = opts.method ?? "POST";
	req.headers = opts.headers ?? {};
	if (opts.preBuffered) {
		// Gateway already drained the stream onto req.body; no stream events fire.
		req.body = Buffer.from(opts.body ?? "", "utf8");
		return req;
	}
	queueMicrotask(() => {
		if (opts.body !== undefined) req.emit("data", Buffer.from(opts.body, "utf8"));
		req.emit("end");
	});
	return req;
}

/** Minimal fake response that records status + body. */
function fakeRes(): { statusCode: number; body: string; headers: Record<string, string>; setHeader: (k: string, v: string) => void; end: (b?: string) => void } {
	const res = {
		statusCode: 0,
		body: "",
		headers: {} as Record<string, string>,
		setHeader(k: string, v: string) {
			res.headers[k] = v;
		},
		end(b?: string) {
			res.body = b ?? "";
		},
	};
	return res;
}

describe("verifySlackSignature", () => {
	const now = 1_700_000_000;
	const ts = String(now);

	it("accepts a correctly-signed request", () => {
		const body = '{"type":"event_callback"}';
		assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: sign(body, ts), timestamp: ts, rawBody: body, nowSeconds: now }), true);
	});

	it("rejects a tampered body / wrong signature", () => {
		const body = '{"type":"event_callback"}';
		assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: sign("other", ts), timestamp: ts, rawBody: body, nowSeconds: now }), false);
	});

	it("rejects a stale timestamp (replay window)", () => {
		const body = "x";
		const stale = String(now - 10_000);
		assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: sign(body, stale), timestamp: stale, rawBody: body, nowSeconds: now }), false);
	});

	it("skips the check when no secret is configured", () => {
		assert.equal(verifySlackSignature({ signingSecret: "", signature: undefined, timestamp: undefined, rawBody: "x" }), true);
	});

	it("rejects when a secret is set but the signature is missing", () => {
		assert.equal(verifySlackSignature({ signingSecret: SECRET, signature: undefined, timestamp: ts, rawBody: "x", nowSeconds: now }), false);
	});
});

describe("parseSlackBody", () => {
	it("parses JSON events", () => {
		const out = parseSlackBody('{"type":"event_callback"}', "application/json");
		assert.equal(out?.kind, "json");
	});

	it("parses an interactive form payload", () => {
		const out = parseSlackBody("payload=" + encodeURIComponent('{"type":"block_actions"}'), "application/x-www-form-urlencoded");
		assert.equal(out?.kind, "interactive");
		assert.equal((out?.data as Record<string, unknown>).type, "block_actions");
	});

	it("parses a slash command form", () => {
		const out = parseSlackBody("command=%2Fstatus&text=foo", "application/x-www-form-urlencoded");
		assert.equal(out?.kind, "slash");
		assert.equal((out?.data as Record<string, unknown>).command, "/status");
	});
});

describe("buildSlackWebhookRoute", () => {
	const now = Math.floor(Date.now() / 1000);
	const ts = String(now);
	const baseRoute = () => {
		const fed: Array<{ kind: string; payload: unknown }> = [];
		const route = buildSlackWebhookRoute({
			path: "/slack/events",
			signingSecret: SECRET,
			resolveSink: () => ({ feedWebhookEvent: (kind, payload) => fed.push({ kind, payload }) }),
		});
		return { route, fed };
	};

	it("declares the route shape (POST, auth none, exact)", () => {
		const { route } = baseRoute();
		assert.equal(route.method, "POST");
		assert.equal(route.path, "/slack/events");
		assert.equal(route.auth, "none");
		assert.equal(route.match, "exact");
		assert.equal(route.skipSessionGuard, true);
	});

	it("rejects a bad signature (401) before routing", async () => {
		const { route, fed } = baseRoute();
		const body = '{"type":"event_callback"}';
		const req = fakeReq({
			headers: { [SLACK_SIGNATURE_HEADER]: "v0=deadbeef", [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 401);
		assert.equal(fed.length, 0);
	});

	it("rejects a non-POST (405)", async () => {
		const { route } = baseRoute();
		const res = fakeRes();
		await route.handler(fakeReq({ method: "GET" }) as never, res as never);
		assert.equal(res.statusCode, 405);
	});

	it("answers the url_verification challenge", async () => {
		const { route } = baseRoute();
		const body = JSON.stringify({ type: "url_verification", challenge: "ch4ll" });
		const req = fakeReq({
			headers: { [SLACK_SIGNATURE_HEADER]: sign(body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 200);
		assert.deepEqual(JSON.parse(res.body), { challenge: "ch4ll" });
	});

	it("feeds an event_callback to the sink and replies 200 {ok:true}", async () => {
		const { route, fed } = baseRoute();
		const body = JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", text: "hi" } });
		const req = fakeReq({
			headers: { [SLACK_SIGNATURE_HEADER]: sign(body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 200);
		assert.deepEqual(JSON.parse(res.body), { ok: true });
		assert.equal(fed.length, 1);
		assert.equal(fed[0]?.kind, "event");
	});

	it("reads the gateway PRE-BUFFERED body (req.body) without re-streaming", async () => {
		// The gateway already drained the stream onto req.body; if the handler
		// re-read the stream it would hang to the 30s timeout. preBuffered emits NO
		// stream events, so this test only passes when the handler reads req.body.
		const { route, fed } = baseRoute();
		const body = JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", text: "buffered" } });
		const req = fakeReq({
			headers: { [SLACK_SIGNATURE_HEADER]: sign(body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
			preBuffered: true,
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 200);
		assert.equal(fed.length, 1);
		assert.equal(fed[0]?.kind, "event");
	});

	it("routes an interactive payload to the sink", async () => {
		const { route, fed } = baseRoute();
		const body = "payload=" + encodeURIComponent('{"type":"block_actions","actions":[{"action_id":"brigade_approval","value":"bv1:a:o"}]}');
		const req = fakeReq({
			headers: { [SLACK_SIGNATURE_HEADER]: sign(body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 200);
		assert.equal(fed[0]?.kind, "interactive");
	});
});
