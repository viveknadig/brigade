/**
 * Slack Events-API gateway route.
 *
 * In events transport mode (`channels.slack.mode: "events"`) Slack POSTs each
 * event to a public URL instead of Brigade opening a Socket Mode websocket. This
 * module builds the Brigade `HttpRoute` that receives those POSTs:
 *
 *   1. Verify the `X-Slack-Signature` header. Slack signs every request as
 *      `v0=` + HMAC-SHA256 of `v0:${timestamp}:${rawBody}` keyed with the app's
 *      signing secret. A mismatch (or a stale timestamp outside the replay
 *      window) → 401, BEFORE the body is routed, so a forged event can't reach
 *      the agent. The signature is computed over the RAW body, so the handler
 *      reads the raw bytes first and verifies before `JSON.parse`.
 *   2. Answer the one-time `url_verification` handshake by echoing the
 *      `challenge` value (Slack's endpoint-ownership check).
 *   3. For an `event_callback`, hand the inner event to the started Slack
 *      adapter's `feedWebhookEvent("event", …)`, which runs it through the SAME
 *      normalize + dedupe + dispatch path Socket Mode uses. Interactive
 *      (`block_actions`) + slash-command payloads arrive as
 *      `application/x-www-form-urlencoded` with a `payload=` field and route via
 *      `feedWebhookEvent("interactive" | "slash", …)`.
 *   4. Reply `200` so Slack marks the event delivered.
 *
 * The route is registered with `auth: "none"` because Slack authenticates via
 * the signed request, not Brigade's operator-auth (Slack can't present an
 * operator credential). The signature check IS the auth.
 *
 * Socket mode never registers this route — it's added by the module only when
 * events mode is configured, so the default local-first install exposes no
 * inbound HTTP surface. Slack mirror of `telegram/webhook.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpRoute } from "../sdk.js";

/** Slack's request-signature header. */
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
/** Slack's request-timestamp header (replay-window guard). */
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Signature version prefix Slack uses (`v0`). */
const SLACK_SIG_VERSION = "v0";
/** Reject a request whose timestamp is older than this (replay protection). */
const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;
/** Cap on the webhook body (a Slack event is small; 1 MiB is generous). */
const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Constant-time compare of two hex signatures — avoids leaking via timing. */
export function safeEqualSignature(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}

/**
 * Verify a Slack request signature over the raw body. Returns false when no
 * secret is configured AND a signature was supplied (a configured Slack app
 * always signs), when the timestamp is missing / stale, or when the computed
 * `v0=` HMAC doesn't match. When `expectedSecret` is empty the check is SKIPPED
 * (returns true) — the operator opted out of verification (not recommended).
 */
export function verifySlackSignature(args: {
	signingSecret: string;
	signature: string | undefined;
	timestamp: string | undefined;
	rawBody: string;
	nowSeconds?: number;
}): boolean {
	if (!args.signingSecret) return true; // no secret configured → no check
	const sig = typeof args.signature === "string" ? args.signature : "";
	const ts = typeof args.timestamp === "string" ? args.timestamp : "";
	if (!sig || !ts) return false;
	const tsNum = Number.parseInt(ts, 10);
	if (!Number.isFinite(tsNum)) return false;
	const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - tsNum) > MAX_TIMESTAMP_SKEW_SECONDS) return false; // stale → replay guard
	const base = `${SLACK_SIG_VERSION}:${ts}:${args.rawBody}`;
	const computed = `${SLACK_SIG_VERSION}=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;
	return safeEqualSignature(computed, sig);
}

/** Read a request body up to `maxBytes`, rejecting (→ null) when it overflows. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		req.on("data", (chunk: Buffer) => {
			if (overflowed) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflowed = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (overflowed) return;
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", () => resolve(null));
	});
}

/**
 * Parse the request payload. Slack delivers EVENTS as JSON
 * (`application/json`) and INTERACTIONS / SLASH-COMMANDS as
 * `application/x-www-form-urlencoded` carrying a `payload=` (interactive) or
 * flat form fields (slash). Returns a discriminated shape the handler routes on.
 */
export function parseSlackBody(
	rawBody: string,
	contentType: string,
): { kind: "json"; data: Record<string, unknown> } | { kind: "interactive"; data: Record<string, unknown> } | { kind: "slash"; data: Record<string, unknown> } | null {
	const ct = (contentType ?? "").toLowerCase();
	if (ct.includes("application/json")) {
		try {
			return { kind: "json", data: JSON.parse(rawBody) as Record<string, unknown> };
		} catch {
			return null;
		}
	}
	// Form-encoded: an interactive payload rides as `payload=<json>`; a slash
	// command is flat form fields (`command=/x&text=…`).
	const params = new URLSearchParams(rawBody);
	const payload = params.get("payload");
	if (payload) {
		try {
			return { kind: "interactive", data: JSON.parse(payload) as Record<string, unknown> };
		} catch {
			return null;
		}
	}
	if (params.has("command")) {
		const data: Record<string, unknown> = {};
		for (const [k, v] of params.entries()) data[k] = v;
		return { kind: "slash", data };
	}
	return null;
}

/** The minimal adapter surface the webhook route drives. */
export interface SlackWebhookSink {
	/** Feed a parsed Slack payload into the inbound path. */
	feedWebhookEvent(kind: "event" | "interactive" | "slash", payload: unknown): void;
}

export interface BuildSlackWebhookRouteArgs {
	/** The gateway route path (e.g. `/slack/events`). */
	path: string;
	/** The configured signing secret (`""` → no signature check). */
	signingSecret: string;
	/** Resolve the started adapter to feed events into (null when not started). */
	resolveSink: () => SlackWebhookSink | null;
	/** Logger (token-redacted upstream). */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Build the Brigade `HttpRoute` for the Slack Events API. Register it via
 * `b.httpRoute(...)` from the module when events mode is active.
 */
export function buildSlackWebhookRoute(args: BuildSlackWebhookRouteArgs): HttpRoute {
	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const reply = (status: number, body: unknown, contentType = "application/json"): void => {
			res.statusCode = status;
			res.setHeader("content-type", contentType);
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		};

		// Only POST carries events.
		if ((req.method ?? "").toUpperCase() !== "POST") {
			reply(405, { ok: false, error: "method not allowed" });
			return;
		}
		// The gateway dispatcher has ALREADY drained the request stream and buffered
		// it onto `req.body` (see core/server.ts). Re-reading the stream here would
		// hang until the 30s timeout (→ 408) because the `data`/`end` events already
		// fired. Read the pre-buffered body first; only fall back to streaming when
		// the route is exercised outside the gateway (e.g. a direct unit test).
		const pre = (req as IncomingMessage & { body?: Buffer }).body;
		const raw = pre ? pre.toString("utf8") : await readBody(req, WEBHOOK_MAX_BODY_BYTES);
		if (raw === null) {
			reply(413, { ok: false, error: "payload too large" });
			return;
		}
		// Signature check FIRST (over the RAW body) — refuse a forged event before
		// parsing / routing.
		const sigHeader = req.headers[SLACK_SIGNATURE_HEADER];
		const tsHeader = req.headers[SLACK_TIMESTAMP_HEADER];
		const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
		const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
		if (!verifySlackSignature({ signingSecret: args.signingSecret, signature, timestamp, rawBody: raw })) {
			args.log?.("slack webhook rejected — bad signature");
			reply(401, { ok: false, error: "unauthorized" });
			return;
		}
		const contentType = (() => {
			const c = req.headers["content-type"];
			return Array.isArray(c) ? (c[0] ?? "") : (c ?? "");
		})();
		const parsed = parseSlackBody(raw, contentType);
		if (!parsed) {
			reply(400, { ok: false, error: "invalid body" });
			return;
		}

		// The one-time endpoint-ownership handshake — echo the challenge verbatim.
		if (parsed.kind === "json" && parsed.data["type"] === "url_verification") {
			const challenge = typeof parsed.data["challenge"] === "string" ? parsed.data["challenge"] : "";
			reply(200, { challenge });
			return;
		}

		const sink = args.resolveSink();
		if (sink) {
			try {
				if (parsed.kind === "json" && parsed.data["type"] === "event_callback") {
					sink.feedWebhookEvent("event", parsed.data);
				} else if (parsed.kind === "interactive") {
					sink.feedWebhookEvent("interactive", parsed.data);
				} else if (parsed.kind === "slash") {
					sink.feedWebhookEvent("slash", parsed.data);
				}
			} catch (err) {
				args.log?.("slack webhook dispatch threw", { error: err instanceof Error ? err.message : String(err) });
			}
		}
		// Always 200 so Slack doesn't retry-storm — a dispatch error is ours to fix,
		// not Slack's to redeliver. A slash command replies empty to clear the spinner.
		if (parsed.kind === "slash") {
			reply(200, "");
		} else {
			reply(200, { ok: true });
		}
	};

	return {
		method: "POST",
		path: args.path,
		auth: "none", // Slack can't present operator-auth; the signed request IS the auth.
		match: "exact",
		maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
		skipSessionGuard: true,
		handler,
	};
}
