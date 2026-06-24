/**
 * Slack status / doctor probe — a lightweight `auth.test` reachability check.
 *
 * Slack is token-based and stateless on disk (Socket Mode keeps no local creds
 * the status command can stat), so "is this channel actually working?" can only
 * be answered by asking Slack. This probe does the cheapest possible call — a
 * single `auth.test` over plain HTTPS (no `@slack/web-api`, no socket) — and
 * reports the bot's identity + the workspace it's installed in so
 * `brigade channels status` and `brigade doctor` can show real Slack health.
 *
 * It deliberately does NOT import `@slack/web-api`: a status check must stay
 * fast + dependency-light, and `auth.test` is a trivial POST. The bot token is
 * never logged; it rides in the `Authorization` header which is built locally
 * and discarded.
 *
 * Returns a structured result the caller renders; never throws — a network
 * failure / invalid token surfaces as `{ ok: false, error }` so the status
 * command degrades gracefully instead of crashing. Slack mirror of
 * `telegram/probe.ts`.
 */

const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Bot identity surfaced by the probe (from `auth.test`). */
export interface SlackProbeBot {
	/** Bot user id (`U…` / `W…`). */
	id?: string;
	/** Bot/user handle Slack returns. */
	name?: string;
}

/** Workspace identity surfaced by the probe (from `auth.test`). */
export interface SlackProbeTeam {
	/** Workspace (team) id (`T…`). */
	id?: string;
	/** Workspace display name. */
	name?: string;
}

/** Structured probe result. `ok` true ⇒ token valid + Slack reachable. */
export interface SlackProbeResult {
	ok: boolean;
	/** HTTP status of the `auth.test` call, when one came back. */
	status?: number;
	/** Operator-facing error line when `ok` is false. */
	error?: string;
	/** Round-trip time in ms. */
	elapsedMs: number;
	/** Bot identity (populated on success). */
	bot?: SlackProbeBot;
	/** Workspace identity (populated on success). */
	team?: SlackProbeTeam;
	/**
	 * Epoch ms of the most recent inbound event seen by the STARTED adapter for
	 * this account, when one is running (liveness signal — `auth.test` proves the
	 * token but not that the events stream is flowing). `null` when no inbound has
	 * arrived yet; `undefined` when the probe couldn't consult a live adapter
	 * (e.g. a cold status check before the channel started). Observability only —
	 * a stale value never means "unhealthy" (a quiet channel is idle, not down).
	 */
	lastEventAt?: number | null;
}

export interface SlackProbeArgs {
	/** The resolved bot token (`xoxb-…`). NEVER logged. */
	token: string;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the call. */
	fetchImpl?: typeof fetch;
	/** Probe timeout in ms (default 8s). */
	timeoutMs?: number;
}

/**
 * Run an `auth.test` probe. Resolves to a structured result describing whether
 * the token is valid + Slack is reachable, plus the bot + workspace identity.
 * Never rejects.
 */
export async function probeSlack(args: SlackProbeArgs): Promise<SlackProbeResult> {
	const started = Date.now();
	const token = (args.token ?? "").trim();
	if (!token) {
		return { ok: false, error: "no Slack bot token configured", elapsedMs: 0 };
	}
	const doFetch = args.fetchImpl ?? fetch;
	const timeoutMs = args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	try {
		const res = await doFetch(SLACK_AUTH_TEST_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			signal: controller.signal,
		});
		const elapsedMs = Date.now() - started;
		type AuthTestBody = {
			ok?: boolean;
			error?: string;
			url?: string;
			team?: string;
			user?: string;
			team_id?: string;
			user_id?: string;
			bot_id?: string;
		};
		let body: AuthTestBody | null = null;
		try {
			body = (await res.json()) as AuthTestBody;
		} catch {
			body = null;
		}
		// Slack always returns HTTP 200 for API calls; success/failure rides on the
		// JSON `ok` flag + an `error` code string (e.g. `invalid_auth`).
		if (!res.ok || !body?.ok) {
			const code = body?.error ?? "";
			return {
				ok: false,
				status: res.status,
				error:
					code === "invalid_auth" || code === "not_authed" || code === "account_inactive"
						? "Slack rejected the bot token — reinstall the app and paste a fresh `xoxb-` token."
						: code
							? `Slack auth.test failed (${code}).`
							: `Slack auth.test failed (HTTP ${res.status}).`,
				elapsedMs,
			};
		}
		return {
			ok: true,
			status: res.status,
			elapsedMs,
			bot: {
				...(typeof body.user_id === "string" ? { id: body.user_id } : {}),
				...(typeof body.user === "string" ? { name: body.user } : {}),
			},
			team: {
				...(typeof body.team_id === "string" ? { id: body.team_id } : {}),
				...(typeof body.team === "string" ? { name: body.team } : {}),
			},
		};
	} catch (err) {
		const elapsedMs = Date.now() - started;
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			error: aborted
				? `Slack auth.test timed out after ${timeoutMs}ms`
				: err instanceof Error
					? err.message
					: String(err),
			elapsedMs,
		};
	} finally {
		clearTimeout(timer);
	}
}
