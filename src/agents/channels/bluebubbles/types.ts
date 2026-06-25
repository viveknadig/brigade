/**
 * BlueBubbles REST plumbing + shared transport types.
 *
 * BlueBubbles authenticates EVERY REST call by the server password in the QUERY
 * STRING (`?password=<urlencoded>`), NOT a header. `buildBlueBubblesApiUrl`
 * assembles `${serverUrl}/api/v1/<path>?password=…` (the `URL` constructor
 * URL-encodes the password automatically). `blueBubblesFetchWithTimeout` is the
 * single network primitive every REST helper goes through — and it takes an
 * INJECTABLE `fetch` so tests can mock the wire with zero network.
 */

import { guardedFetch } from "../../../infra/net/fetch-guard.js";

/** Default REST timeout (ms). Attachment uploads override to a longer value. */
export const BLUEBUBBLES_DEFAULT_TIMEOUT_MS = 10_000;

/** The injectable fetch seam — production passes `fetch`; tests pass a mock. */
export type FetchLike = typeof fetch;

export { SsrfBlockedError } from "../../../infra/net/fetch-guard.js";

/**
 * Build a BlueBubbles REST URL. `path` is the API path AFTER `/api/v1/`
 * (e.g. `"message/text"`). The password rides in the query string (the wire's
 * auth) and is URL-encoded by the `URL` builder. `query` adds extra params.
 */
export function buildBlueBubblesApiUrl(params: {
	serverUrl: string;
	path: string;
	password?: string;
	query?: Record<string, string | number | undefined>;
}): string {
	const base = (params.serverUrl ?? "").trim().replace(/\/+$/, "");
	if (!base) throw new Error("BlueBubbles serverUrl is required");
	const cleanPath = params.path.replace(/^\/+/, "");
	const url = new URL(`/api/v1/${cleanPath}`, `${base}/`);
	if (params.password) url.searchParams.set("password", params.password);
	if (params.query) {
		for (const [k, v] of Object.entries(params.query)) {
			if (v === undefined) continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url.toString();
}

/**
 * Fetch a BlueBubbles REST URL through Brigade's SSRF guard with a timeout.
 *
 * Every REST call goes through the guard: it re-checks the host on each redirect
 * hop (so a redirect to `169.254.169.254` / `metadata.*` can't reach cloud
 * metadata) and strips `Authorization`/`Cookie` on cross-origin redirects.
 *
 * A BlueBubbles server is almost always a LAN / private-IP host
 * (`192.168.x.x`, `10.x.x.x`, `localhost`), so `allowPrivateNetwork` defaults to
 * TRUE for this channel — but cloud-metadata stays blocked even then, so the
 * guard still defends against the highest-value SSRF target. The operator can
 * tighten it via `channels.bluebubbles.network.allowPrivate=false`.
 *
 * `fetchImpl` is the test seam (inject a mock); it is threaded into the guard so
 * the SSRF classification still runs but the actual wire call is the mock.
 */
export async function blueBubblesFetchWithTimeout(
	url: string,
	init: RequestInit,
	opts: { timeoutMs?: number; fetchImpl?: FetchLike; allowPrivateNetwork?: boolean } = {},
): Promise<Response> {
	const timeoutMs = opts.timeoutMs ?? BLUEBUBBLES_DEFAULT_TIMEOUT_MS;
	const headers = headersToRecord(init.headers);
	const { response } = await guardedFetch(url, {
		method: init.method ?? "GET",
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
		timeoutMs,
		// LAN servers are the norm for BlueBubbles; default-allow private but keep
		// cloud-metadata blocked. The operator may flip this off per account.
		allowPrivateNetwork: opts.allowPrivateNetwork !== false,
		...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
	});
	return response;
}

/** Coerce a fetch headers init to a plain record for the guard's option shape. */
function headersToRecord(h: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	if (typeof Headers !== "undefined" && h instanceof Headers) {
		h.forEach((v, k) => {
			out[k] = v;
		});
	} else if (Array.isArray(h)) {
		for (const pair of h) {
			const k = pair[0];
			const v = pair[1];
			if (k) out[k] = String(v ?? "");
		}
	} else {
		for (const [k, v] of Object.entries(h as Record<string, string>)) out[k] = String(v ?? "");
	}
	return out;
}

/**
 * Read a BlueBubbles JSON response, returning the `data` field (the API wraps
 * payloads as `{ status, message, data }`). Throws an operator-facing error on a
 * non-2xx response or a server-reported error. `context` names the call for the
 * error message.
 */
export async function readBlueBubblesJson<T = unknown>(res: Response, context: string): Promise<T> {
	let body: unknown = null;
	const text = await res.text();
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	const record = (body && typeof body === "object" ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
	if (!res.ok) {
		const msg =
			(typeof record.message === "string" && record.message) ||
			(typeof record.error === "string" && record.error) ||
			`HTTP ${res.status}`;
		throw new Error(`BlueBubbles ${context} failed: ${msg}`);
	}
	return record.data as T;
}

/** The BlueBubbles `server/info` payload the probe + capability detection read. */
export interface BlueBubblesServerInfo {
	/** macOS version of the host (`"14.4"`, `"26.0"`, …). */
	os_version?: string;
	/** BlueBubbles server version. */
	server_version?: string;
	/** Whether the Private API is enabled (gates reactions/edit/unsend/effects/groups). */
	private_api?: boolean;
	/** Whether the BlueBubbles helper bundle is connected. */
	helper_connected?: boolean;
	/** Proxy service in use (ngrok / cloudflare / …). */
	proxy_service?: string;
	[key: string]: unknown;
}
