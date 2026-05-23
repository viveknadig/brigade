/**
 * Webhook + RPC guards — body-size cap, timeout, HMAC helpers.
 *
 * Used by the gateway's HTTP route dispatcher to enforce per-route guarantees
 * BEFORE a plugin's handler ever sees the request, and exposed to plugin
 * authors so a webhook handler can verify provider-signed payloads (Stripe,
 * GitHub, LINE, Slack, etc.) without re-implementing the careful crypto bits.
 *
 * Three primitives:
 *   - `readBodyWithLimit(req, res, opts)` — pre-buffer the body up to a byte
 *     cap. Sends `413 Payload Too Large` (or `408 Request Timeout`) directly
 *     and returns `null` so the handler can early-out. The cap defaults to
 *     1 MiB, mirroring the reference upstream's post-auth limit; the timeout
 *     defaults to 30s.
 *   - `computeHmacSha256(body, secret)` — canonical hex HMAC-SHA256 for the
 *     provider signature schemes that use hex (Stripe v1, GitHub `sha256=…`,
 *     etc). Returns the bare hex string so callers can prefix `sha256=` etc.
 *     to match the provider's wire format.
 *   - `safeEqualHmac(expected, actual)` — timing-safe string compare via
 *     `crypto.timingSafeEqual` on equal-length padded buffers. Avoids the
 *     early-exit length-leak that the naive `===` path has, and never
 *     throws on length mismatch (the LINE adapter taught us that one).
 *
 * Plugin-author contract: a webhook handler that opts into `auth: "none"`
 * MUST verify the signature itself — these helpers are the supported way.
 * Routes that opt into `auth: "operator"` are gated by the gateway before
 * the handler runs and can skip the HMAC step entirely.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Default cap when a route doesn't declare `maxBodyBytes`. Matches the reference upstream's post-auth limit. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Default timeout when a route doesn't declare `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000; // 30s

/**
 * Read a request body up to `maxBytes`. Streams the request, accumulating
 * chunks until either the body ends (returns the `Buffer`) or the running
 * total exceeds the cap (responds `413` + returns `null`). A per-call
 * timeout aborts the read and responds `408` if the client takes too long.
 *
 * Why pre-buffer at all? Plugin handlers want a `Buffer` they can HMAC-verify
 * against the provider's signature header. Letting the handler consume the
 * stream itself loses the size guard — and the typical "re-emit the chunks"
 * shim is a foot-gun (every author gets it slightly wrong). Buffering once,
 * up front, lands the body where it's wanted with the safety baked in.
 *
 * Always writes a JSON body on rejection so the caller (or curl) sees what
 * happened, never just a bare status line.
 */
export async function readBodyWithLimit(
	req: IncomingMessage,
	res: ServerResponse,
	opts?: { maxBytes?: number; timeoutMs?: number },
): Promise<Buffer | null> {
	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise<Buffer | null>((resolve) => {
		const chunks: Buffer[] = [];
		let received = 0;
		let settled = false;

		const finish = (value: Buffer | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("aborted", onAborted);
			resolve(value);
		};

		const writeStatus = (status: number, message: string): void => {
			if (!res.headersSent) {
				res.statusCode = status;
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify({ error: message }));
			} else if (!res.writableEnded) {
				try {
					res.end();
				} catch {
					/* socket already torn down */
				}
			}
		};

		const onData = (chunk: Buffer | string): void => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			received += buf.length;
			if (received > maxBytes) {
				writeStatus(413, `Payload too large (max ${maxBytes} bytes)`);
				// Drain the rest of the stream so the client doesn't hang on
				// a half-closed socket. Node ignores additional data after
				// res.end() but the request side still wants its end event.
				try {
					req.pause();
				} catch {
					/* ignore */
				}
				finish(null);
				return;
			}
			chunks.push(buf);
		};

		const onEnd = (): void => {
			finish(Buffer.concat(chunks, received));
		};

		const onError = (): void => {
			writeStatus(400, "Bad request body");
			finish(null);
		};

		const onAborted = (): void => {
			// Client hung up mid-body; nothing to respond with, just clean up.
			finish(null);
		};

		const timer = setTimeout(() => {
			writeStatus(408, `Request timeout (${timeoutMs}ms)`);
			finish(null);
		}, timeoutMs);
		// Don't keep the event loop alive on this timer alone.
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
	});
}

/**
 * Compute HMAC-SHA256 of `body` with `secret` and return the hex digest.
 * The hex shape is what GitHub (`sha256=…`), Stripe (`v1=…`), and most other
 * providers send on the wire; callers can prefix as needed.
 */
export function computeHmacSha256(body: Buffer | string, secret: string): string {
	const data = typeof body === "string" ? Buffer.from(body) : body;
	return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Timing-safe HMAC compare. Always reads the same number of bytes regardless
 * of where the strings differ, and tolerates length mismatch by padding both
 * sides to the longest length before the constant-time compare (then returns
 * `false` if the original lengths differed). Never throws — a length mismatch
 * passed to `crypto.timingSafeEqual` directly would.
 *
 * Use for any string-vs-string secret comparison: HMAC hex digests, base64
 * signatures, shared-secret tokens. NOT for password hashes — use a slow KDF
 * for those (bcrypt/argon2).
 */
export function safeEqualHmac(expected: string, actual: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	const maxLen = Math.max(a.length, b.length);
	// Allocate fixed-length buffers so timingSafeEqual never throws on
	// mismatched lengths. We still return false below when the original
	// lengths differ — the constant-time compare is just for the bytes.
	const padA = Buffer.alloc(maxLen);
	const padB = Buffer.alloc(maxLen);
	a.copy(padA);
	b.copy(padB);
	// Call timingSafeEqual unconditionally so the && short-circuit can't
	// leak length information through wall-clock timing.
	const bytesEqual = timingSafeEqual(padA, padB);
	return a.length === b.length && bytesEqual;
}
