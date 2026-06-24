/**
 * Discord status / doctor probe — a lightweight `GET /users/@me` reachability
 * check.
 *
 * Discord is token-based and stateless on disk (the Gateway keeps no local creds
 * the status command can stat), so "is this channel actually working?" can only
 * be answered by asking Discord. This probe does the cheapest possible call — a
 * single `GET /users/@me` over plain HTTPS (no `discord.js`, no gateway socket)
 * with the `Authorization: Bot <token>` header — and reports the bot's identity
 * so `brigade channels status` and `brigade doctor` can show real Discord health.
 *
 * It deliberately does NOT import `discord.js`: a status check must stay fast +
 * dependency-light, and `/users/@me` is a trivial GET. The bot token is never
 * logged; it rides in the `Authorization` header which is built locally and
 * discarded.
 *
 * Returns a structured result the caller renders; never throws — a network
 * failure / invalid token surfaces as `{ ok: false, error }` so the status
 * command degrades gracefully instead of crashing. Discord mirror of
 * `slack/probe.ts`.
 */

import { stripBotPrefix } from "./account-config.js";

const DISCORD_ME_URL = "https://discord.com/api/v10/users/@me";
/** Application-metadata endpoint — carries the `flags` bitfield we decode for the MESSAGE CONTENT intent. */
const DISCORD_APP_URL = "https://discord.com/api/v10/oauth2/applications/@me";
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Application-flag bits that indicate the bot HAS the privileged MESSAGE CONTENT
 * intent. `GATEWAY_MESSAGE_CONTENT` (1 << 18) is set when the intent is enabled;
 * `GATEWAY_MESSAGE_CONTENT_LIMITED` (1 << 19) when it's available only to a
 * limited number of servers (still readable). Neither set, with the intent
 * requested, means it's DISABLED — the bot connects but can't read message text.
 */
const FLAG_MESSAGE_CONTENT = 1 << 18;
const FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;

/** Decoded state of the privileged MESSAGE CONTENT intent. */
export type MessageContentIntentState = "enabled" | "limited" | "disabled";

/**
 * Decode the MESSAGE CONTENT intent state from an application `flags` bitfield.
 * `enabled` (full), `limited` (limited rollout — still reads content), or
 * `disabled` (neither bit set). Returns `undefined` when `flags` isn't a number
 * (the flags fetch was skipped / failed) so callers don't warn on missing data.
 */
export function decodeMessageContentIntent(flags: unknown): MessageContentIntentState | undefined {
	if (typeof flags !== "number" || !Number.isFinite(flags)) return undefined;
	if ((flags & FLAG_MESSAGE_CONTENT) !== 0) return "enabled";
	if ((flags & FLAG_MESSAGE_CONTENT_LIMITED) !== 0) return "limited";
	return "disabled";
}

/** Operator-facing warning surfaced when the MESSAGE CONTENT intent is disabled. */
export const MESSAGE_CONTENT_DISABLED_WARNING =
	"Enable the MESSAGE CONTENT intent in the Discord Developer Portal — the bot can't read channel messages without it.";

/** Bot identity surfaced by the probe (from `/users/@me`). */
export interface DiscordProbeBot {
	/** Bot user id (snowflake). */
	id?: string;
	/** Bot username. */
	name?: string;
	/** Discriminator (legacy `#0001`) when present. */
	discriminator?: string;
}

/** Structured probe result. `ok` true ⇒ token valid + Discord reachable. */
export interface DiscordProbeResult {
	ok: boolean;
	/** HTTP status of the `/users/@me` call, when one came back. */
	status?: number;
	/** Operator-facing error line when `ok` is false. */
	error?: string;
	/** Round-trip time in ms. */
	elapsedMs: number;
	/** Bot identity (populated on success). */
	bot?: DiscordProbeBot;
	/**
	 * Epoch ms of the most recent inbound event seen by the STARTED adapter for
	 * this account, when one is running (liveness signal — `/users/@me` proves the
	 * token but not that the Gateway stream is flowing). `null` when no inbound has
	 * arrived yet; `undefined` when the probe couldn't consult a live adapter (a
	 * cold status check before the channel started). Observability only — a stale
	 * value never means "unhealthy" (a quiet channel is idle, not down).
	 */
	lastEventAt?: number | null;
	/**
	 * State of the privileged MESSAGE CONTENT intent, decoded from the bot's
	 * application flags. `"disabled"` is the #1 Discord footgun — the bot connects
	 * fine but silently can't read channel messages. `undefined` when the flags
	 * check was skipped or failed (best-effort; never fails the probe).
	 */
	messageContentIntent?: MessageContentIntentState;
	/**
	 * Operator-facing warning when {@link messageContentIntent} is `"disabled"`.
	 * `undefined` otherwise. The status surface renders it so the operator knows to
	 * flip the intent toggle.
	 */
	messageContentWarning?: string;
}

export interface DiscordProbeArgs {
	/** The resolved bot token. NEVER logged. */
	token: string;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the call. */
	fetchImpl?: typeof fetch;
	/** Probe timeout in ms (default 8s). */
	timeoutMs?: number;
}

/**
 * Best-effort fetch of the bot's application `flags`, decoded into the MESSAGE
 * CONTENT intent state. Runs only AFTER `/users/@me` succeeds (the token is
 * known good). A failed fetch / non-ok / unparseable body returns `undefined` so
 * the probe NEVER fails on it — the intent state is observability, not health.
 */
async function probeMessageContentIntent(
	doFetch: typeof fetch,
	token: string,
	signal: AbortSignal,
): Promise<MessageContentIntentState | undefined> {
	try {
		const res = await doFetch(DISCORD_APP_URL, {
			method: "GET",
			headers: { Authorization: `Bot ${token}`, "content-type": "application/json" },
			signal,
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { flags?: unknown };
		return decodeMessageContentIntent(body?.flags);
	} catch {
		return undefined;
	}
}

/**
 * Run a `GET /users/@me` probe. Resolves to a structured result describing
 * whether the token is valid + Discord is reachable, plus the bot identity. On
 * success it ALSO best-effort decodes the privileged MESSAGE CONTENT intent
 * (`/oauth2/applications/@me` → `flags`) and surfaces a warning when it's
 * disabled — without that intent the bot connects but can't read channel
 * messages. Never rejects.
 */
export async function probeDiscord(args: DiscordProbeArgs): Promise<DiscordProbeResult> {
	const started = Date.now();
	const token = stripBotPrefix((args.token ?? "").trim());
	if (!token) {
		return { ok: false, error: "no Discord bot token configured", elapsedMs: 0 };
	}
	const doFetch = args.fetchImpl ?? fetch;
	const timeoutMs = args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	try {
		const res = await doFetch(DISCORD_ME_URL, {
			method: "GET",
			headers: {
				Authorization: `Bot ${token}`,
				"content-type": "application/json",
			},
			signal: controller.signal,
		});
		const elapsedMs = Date.now() - started;
		type MeBody = { id?: string; username?: string; discriminator?: string; bot?: boolean; message?: string; code?: number };
		let body: MeBody | null = null;
		try {
			body = (await res.json()) as MeBody;
		} catch {
			body = null;
		}
		if (!res.ok) {
			// 401 = bad/expired token; otherwise surface the status + any message.
			return {
				ok: false,
				status: res.status,
				error:
					res.status === 401
						? "Discord rejected the bot token — reset it in the Developer Portal and paste the fresh token."
						: body?.message
							? `Discord /users/@me failed (${body.message}).`
							: `Discord /users/@me failed (HTTP ${res.status}).`,
				elapsedMs,
			};
		}
		// Token is good — best-effort decode the MESSAGE CONTENT intent (never fails
		// the probe). Reuses the same abort signal/timeout window as the identity call.
		const messageContentIntent = await probeMessageContentIntent(doFetch, token, controller.signal);
		return {
			ok: true,
			status: res.status,
			elapsedMs,
			bot: {
				...(typeof body?.id === "string" ? { id: body.id } : {}),
				...(typeof body?.username === "string" ? { name: body.username } : {}),
				...(typeof body?.discriminator === "string" && body.discriminator !== "0" ? { discriminator: body.discriminator } : {}),
			},
			...(messageContentIntent ? { messageContentIntent } : {}),
			...(messageContentIntent === "disabled" ? { messageContentWarning: MESSAGE_CONTENT_DISABLED_WARNING } : {}),
		};
	} catch (err) {
		const elapsedMs = Date.now() - started;
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			error: aborted
				? `Discord /users/@me timed out after ${timeoutMs}ms`
				: err instanceof Error
					? err.message
					: String(err),
			elapsedMs,
		};
	} finally {
		clearTimeout(timer);
	}
}
