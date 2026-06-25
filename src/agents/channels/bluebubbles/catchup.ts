/**
 * BlueBubbles catch-up backfill.
 *
 * BlueBubbles delivers inbound via webhook POST. When Brigade is down (restart,
 * crash, upgrade) the server's webhook fire fails and is NOT retried, so any
 * message that arrived during the outage is lost. On (re)connect, catch-up
 * queries the server for messages delivered in a bounded recent window
 * (`POST /api/v1/message/query`, `after: <sinceMs>`, capped by `limit`) and
 * re-feeds each one through the SAME path a live webhook event takes —
 * normalize → dedupe → dispatch.
 *
 * The dedupe is what makes this safe: a message already delivered live (or in a
 * previous catch-up pass) is claimed in the connection's dedupe cache, so the
 * replay is dropped there and the agent NEVER replies twice. Catch-up therefore
 * recovers ONLY the genuinely-missed messages.
 *
 * `fetch` is INJECTABLE (the test seam) so the whole query → replay path runs
 * with no live server. Never throws — a query failure logs and leaves the live
 * webhook path untouched.
 */

import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl, type FetchLike } from "./types.js";

/** Default lookback window when running catch-up (30 min). */
export const BLUEBUBBLES_CATCHUP_DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;
/** Default per-run message cap. */
export const BLUEBUBBLES_CATCHUP_DEFAULT_LIMIT = 50;
/** Hard ceiling on the per-run cap (defends against an unbounded backlog). */
export const BLUEBUBBLES_CATCHUP_MAX_LIMIT = 500;

/** Tunables for one catch-up run. */
export interface BlueBubblesCatchupConfig {
	/** Disable catch-up entirely. */
	enabled?: boolean;
	/** How far back to look (ms). */
	lookbackMs?: number;
	/** Max messages to fetch in one run. */
	limit?: number;
}

/** Args for one catch-up run. */
export interface RunBlueBubblesCatchupArgs {
	serverUrl: string;
	password: string;
	config?: BlueBubblesCatchupConfig;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
	/**
	 * Re-feed one raw message record through the connection's live webhook path
	 * (normalize → dedupe → dispatch). The connection wires this to the SAME
	 * `feedWebhookEvent` a real webhook uses, so dedupe drops any already-seen
	 * message. Wrapped in a `new-message` envelope by the caller is NOT required —
	 * this hands the raw record straight to the normalizer.
	 */
	feedRecord: (record: Record<string, unknown>) => void;
	/** Optional logger. */
	log?: (msg: string) => void;
	/** Clock seam (tests). */
	now?: () => number;
}

/** Outcome of a catch-up run (for logging + tests). */
export interface BlueBubblesCatchupSummary {
	/** True when the server query returned a recognised response. */
	querySucceeded: boolean;
	/** How many records the query returned. */
	fetched: number;
	/** How many were re-fed into the inbound path (pre-dedupe). */
	replayed: number;
	/** The `after` timestamp the query used (epoch ms). */
	windowStartMs: number;
}

/** Clamp the per-run limit into `[1, MAX]`. */
function clampLimit(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : BLUEBUBBLES_CATCHUP_DEFAULT_LIMIT;
	return Math.min(Math.max(n, 1), BLUEBUBBLES_CATCHUP_MAX_LIMIT);
}

/**
 * Run one bounded catch-up pass. Queries the server for messages newer than the
 * lookback window and re-feeds each through `feedRecord` (the connection's
 * normalize+dedupe path). Returns a summary; never throws.
 */
export async function runBlueBubblesCatchup(args: RunBlueBubblesCatchupArgs): Promise<BlueBubblesCatchupSummary> {
	const cfg = args.config ?? {};
	const nowMs = (args.now ?? Date.now)();
	const lookbackMs =
		typeof cfg.lookbackMs === "number" && cfg.lookbackMs > 0 ? cfg.lookbackMs : BLUEBUBBLES_CATCHUP_DEFAULT_LOOKBACK_MS;
	const windowStartMs = nowMs - lookbackMs;
	const limit = clampLimit(cfg.limit);

	const summary: BlueBubblesCatchupSummary = {
		querySucceeded: false,
		fetched: 0,
		replayed: 0,
		windowStartMs,
	};

	if (cfg.enabled === false) return summary;

	let records: Array<Record<string, unknown>> = [];
	try {
		const url = buildBlueBubblesApiUrl({ serverUrl: args.serverUrl, path: "message/query", password: args.password });
		const res = await blueBubblesFetchWithTimeout(
			url,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					limit,
					sort: "ASC",
					after: windowStartMs,
					// Match the fields the live webhook carries so normalize sees the same shape.
					with: ["chat", "chat.participants", "attachment", "handle"],
				}),
			},
			{ ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}) },
		);
		if (!res.ok) {
			args.log?.(`catchup: message/query returned HTTP ${res.status}`);
			return summary;
		}
		const text = await res.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		const data = body.data;
		if (!Array.isArray(data)) {
			args.log?.("catchup: message/query returned no data array");
			return summary;
		}
		records = data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
		summary.querySucceeded = true;
		summary.fetched = records.length;
	} catch (err) {
		args.log?.(`catchup: message/query failed: ${err instanceof Error ? err.message : String(err)}`);
		return summary;
	}

	for (const record of records) {
		// Re-feed through the SAME normalize+dedupe path a live webhook uses. The
		// connection's dedupe cache drops any message already delivered live (or
		// in a prior catch-up pass), so this can never double-deliver.
		try {
			args.feedRecord(record);
			summary.replayed++;
		} catch {
			/* one bad record never aborts the backfill */
		}
	}

	args.log?.(`catchup: fetched=${summary.fetched} replayed=${summary.replayed} window_ms=${nowMs - windowStartMs}`);
	return summary;
}
