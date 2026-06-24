/**
 * Slack config-shape helpers (multi-WORKSPACE aware; mirrors Telegram's
 * `account-config.ts`).
 *
 * Slack needs MORE than one secret per workspace, unlike Telegram's single bot
 * token:
 *   - `botToken`    (`xoxb-…`) — the bot user token; every Web API call uses it.
 *   - `appToken`    (`xapp-…`) — the app-level token; REQUIRED for Socket Mode
 *                                 (opens the events websocket via
 *                                 `apps.connections.open`).
 *   - `signingSecret`          — HMAC secret; REQUIRED for Events-API (HTTP)
 *                                 mode to verify Slack's request signature.
 *   - `userToken`   (`xoxp-…`) — OPTIONAL; user-scoped token for reads that the
 *                                 bot token can't do (e.g. some file fetches).
 *
 * Two config shapes are recognised so the surface lines up with WhatsApp /
 * Telegram:
 *
 *   Legacy (single-workspace):
 *     channels.slack = { enabled: true, botToken: "xoxb-…", appToken: "xapp-…" }
 *
 *   Multi-workspace:
 *     channels.slack = {
 *       enabled: true,
 *       accounts: [
 *         { id: "acme", botToken: "xoxb-AAA", appToken: "xapp-AAA" },
 *         { id: "labs", botToken: "xoxb-BBB", appToken: "xapp-BBB" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 *
 * Token resolution mirrors Telegram: a `${VAR}` ref expands against
 * `process.env`; otherwise the literal passes through; then — for the bot token
 * only — a DURABLE sealed token (written by `connect_channel`) is consulted so
 * the channel survives a reboot; finally a per-secret env var is the last-resort
 * fallback.
 *
 * Honesty note on sealing: `connect_channel` seals exactly ONE secret per
 * channel, under `channel:slack` — that is the BOT token. The app-level token
 * and signing secret are NOT durably sealed today; they must come from config
 * (`${VAR}`/literal) or their per-secret env var (`SLACK_APP_TOKEN` /
 * `SLACK_SIGNING_SECRET`). If a future `connect_channel` learns to seal those
 * under `channel:slack:app` / `channel:slack:signing`, wire the sealed-read
 * fallback back into `resolveSlackAppToken` / `resolveSlackSigningSecret`.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { readSealedChannelToken } from "../channel-secrets.js";

const CHANNEL_ID = "slack";
const DEFAULT_ACCOUNT_ID = "default";

/** Per-secret env vars consulted as a last-resort fallback. */
const BOT_TOKEN_ENV_VAR = "SLACK_BOT_TOKEN";
const APP_TOKEN_ENV_VAR = "SLACK_APP_TOKEN";
const SIGNING_SECRET_ENV_VAR = "SLACK_SIGNING_SECRET";
const USER_TOKEN_ENV_VAR = "SLACK_USER_TOKEN";

/**
 * Standard proxy env vars consulted as a last-resort proxy fallback, in
 * precedence order. Lower-case wins over upper-case (curl/undici convention),
 * and a TLS-oriented `https_proxy` outranks the catch-all `ALL_PROXY`. These
 * mirror the keys undici's own `EnvHttpProxyAgent` honours (same set Telegram
 * uses).
 */
const PROXY_ENV_VARS = ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] as const;

/**
 * Sealed-token key for the bot token (`channel:slack`) — the ONLY Slack secret
 * `connect_channel` seals today. The app token + signing secret are not sealed
 * (see the header note), so their resolvers pass `sealKey: null`.
 */
const SEAL_KEY_BOT = CHANNEL_ID; // `channel:slack`

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Default gateway path the Events-API transport registers + Slack POSTs to. */
const DEFAULT_EVENTS_PATH = "/slack/events";

/** Raw shape of one entry under `channels.slack.accounts`. */
interface SlackAccountEntry {
	id?: string;
	enabled?: boolean;
	botToken?: string;
	appToken?: string;
	signingSecret?: string;
	userToken?: string;
	/**
	 * Per-account events-mode gateway path. When unset the resolver derives one
	 * (`${basePath}/<accountId>` for named accounts) so two workspaces don't
	 * collide on the same route. `${VAR}`-resolved like the other fields.
	 */
	webhookPath?: string;
	/** Per-account proxy URL (`http(s)://[user:pass@]host:port`). `${VAR}`-resolved. */
	proxy?: string;
	[key: string]: unknown;
}

interface SlackChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	botToken?: string;
	appToken?: string;
	signingSecret?: string;
	userToken?: string;
	/**
	 * Top-level proxy URL applied to ALL accounts that don't set their own
	 * `accounts[].proxy`. Use this on networks where `slack.com` is blocked —
	 * every Web API call + the Socket Mode websocket route through it. Form:
	 * `http(s)://[user:pass@]host:port` for an HTTP CONNECT proxy, or
	 * `socks5://[user:pass@]host:port` (also `socks://` / `socks4://` /
	 * `socks5h://`) for a SOCKS proxy. `${VAR}`-resolved like `botToken`. Env
	 * fallback: `HTTPS_PROXY` / `ALL_PROXY`.
	 */
	proxy?: string;
	accounts?: SlackAccountEntry[];
	/** Transport mode — `"socket"` (default, local-first) or `"events"` (HTTP). */
	mode?: string;
	/** Events-API config (only consulted when `mode === "events"`). */
	events?: SlackEventsConfigSlot;
	/** Idle TTL (ms / duration string) after which idle thread sessions are reaped. */
	threadIdleTtlMs?: number | string;
	/**
	 * Live-stream the agent reply by progressively editing one message as tokens
	 * arrive (default OFF → one final chunked message). When true the adapter
	 * posts a placeholder and edits it ~1×/sec until the turn settles.
	 */
	liveStream?: boolean;
	/** Override the streaming edit throttle in ms (clamped ≥ 250). Default 1000. */
	streamThrottleMs?: number;
	/**
	 * ALSO deliver the model's `<think>` reasoning as a separate prefixed message
	 * (default OFF). The answer message is unchanged either way.
	 */
	surfaceReasoning?: boolean;
	[key: string]: unknown;
}

/** Raw `channels.slack.events` shape (Events-API / HTTP mode). */
interface SlackEventsConfigSlot {
	/** Public base URL Slack POSTs events to (e.g. `https://bot.example.com`). */
	url?: string;
	/** Route path on the gateway (default `/slack/events`). */
	path?: string;
	[key: string]: unknown;
}

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedSlackAccount {
	accountId: string;
	enabled: boolean;
	/** Bot user token (`xoxb-…`), fully resolved, or `""` when unset. */
	botToken: string;
	/** App-level token (`xapp-…`) for Socket Mode, fully resolved, or `""`. */
	appToken: string;
	/** HMAC signing secret for Events-API mode, fully resolved, or `""`. */
	signingSecret: string;
	/** Optional user token (`xoxp-…`) for user-scoped reads, or `""`. */
	userToken: string;
	/**
	 * Proxy URL all Slack API calls + the Socket Mode websocket route through,
	 * fully resolved (`${VAR}` + env fallback applied), or `""` for a direct
	 * connection (the default).
	 */
	proxyUrl: string;
	verbose: boolean;
}

/** Read `channels.slack` loosely (schema keeps it open). */
function slackChannelConfig(cfg: BrigadeConfig): SlackChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, SlackChannelConfigSlot> }).channels?.[CHANNEL_ID];
}

/**
 * Resolve a single token-ish string: a `${VAR}` ref expands against
 * `process.env`; any other non-empty string passes through verbatim; empty /
 * missing returns "".
 */
function resolveTokenRef(raw: string | undefined, env: NodeJS.ProcessEnv): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const m = SECRET_REF_PATTERN.exec(trimmed);
	if (m && m[1]) return (env[m[1]] ?? "").trim();
	return trimmed;
}

/** Is the Slack channel switched on at all (any shape)? */
export function slackChannelEnabled(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listSlackAccountIds(cfg: BrigadeConfig): string[] {
	const slot = slackChannelConfig(cfg);
	if (!slot || slot.enabled !== true) return [];
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts || accounts.length === 0) return [DEFAULT_ACCOUNT_ID];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	// A half-typed `accounts:[]` still degrades to the default account so the
	// channel isn't silently disabled.
	return ids.length === 0 ? [DEFAULT_ACCOUNT_ID] : ids;
}

/** Look up the raw account entry from config (or null when missing). */
function findAccountEntry(cfg: BrigadeConfig, accountId: string): SlackAccountEntry | null {
	const slot = slackChannelConfig(cfg);
	if (!slot) return null;
	const accounts = Array.isArray(slot.accounts) ? slot.accounts : undefined;
	if (!accounts) return null;
	for (const entry of accounts) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (id === accountId) return entry;
	}
	return null;
}

/**
 * Resolve one Slack secret for an account. Precedence (mirrors Telegram's token
 * resolution): per-account config `${VAR}`/literal → top-level config → durable
 * sealed token → per-secret env var. Returns `""` when nothing resolves.
 */
function resolveSecret(
	cfg: BrigadeConfig,
	accountId: string | null | undefined,
	field: "botToken" | "appToken" | "signingSecret" | "userToken",
	sealKey: string | null,
	envVar: string | null,
	env: NodeJS.ProcessEnv,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = slackChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.[field] as string | undefined, env);
	if (perAccount) return perAccount;
	const topLevel = resolveTokenRef(slot?.[field] as string | undefined, env);
	if (topLevel) return topLevel;
	if (sealKey) {
		const sealed = readSealedChannelToken(sealKey);
		if (sealed) return sealed;
	}
	if (envVar) {
		const fromEnv = (env[envVar] ?? "").trim();
		if (fromEnv) return fromEnv;
	}
	return "";
}

/** Resolve the bot user token (`xoxb-…`) for an account. */
export function resolveSlackBotToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "botToken", SEAL_KEY_BOT, BOT_TOKEN_ENV_VAR, env);
}

/**
 * Resolve the app-level token (`xapp-…`, Socket Mode) for an account. NOT sealed
 * by `connect_channel` today (sealKey `null`) — comes from config or
 * `SLACK_APP_TOKEN`.
 */
export function resolveSlackAppToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "appToken", null, APP_TOKEN_ENV_VAR, env);
}

/**
 * Resolve the HMAC signing secret (Events-API mode) for an account. NOT sealed
 * by `connect_channel` today (sealKey `null`) — comes from config or
 * `SLACK_SIGNING_SECRET`.
 */
export function resolveSlackSigningSecret(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "signingSecret", null, SIGNING_SECRET_ENV_VAR, env);
}

/** Resolve the optional user token (`xoxp-…`) for an account. */
export function resolveSlackUserToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return resolveSecret(cfg, accountId, "userToken", null, USER_TOKEN_ENV_VAR, env);
}

/**
 * Resolve the proxy URL all Slack API calls (+ the Socket Mode websocket) should
 * route through. Precedence (mirrors Telegram's `resolveTelegramProxyUrl`):
 *   1. The per-account `accounts[].proxy` (multi-workspace shape), `${VAR}`-resolved.
 *   2. The top-level `channels.slack.proxy`, `${VAR}`-resolved.
 *   3. The first set standard proxy env var (`https_proxy` / `HTTPS_PROXY` /
 *      `all_proxy` / `ALL_PROXY`) — last-resort fallback.
 * Returns `""` when none is configured → a DIRECT connection (the default,
 * byte-unchanged from before proxy support existed).
 *
 * `${VAR}` refs are resolved here the same way `botToken` is, so an operator can
 * keep the proxy (which may carry `user:pass@` creds) out of the committed
 * config as `channels.slack.proxy: "${SLACK_PROXY}"`.
 */
export function resolveSlackProxyUrl(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = slackChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.proxy as string | undefined, env);
	if (perAccount) return perAccount;
	const topLevel = resolveTokenRef(slot?.proxy as string | undefined, env);
	if (topLevel) return topLevel;
	for (const key of PROXY_ENV_VARS) {
		const value = (env[key] ?? "").trim();
		if (value) return value;
	}
	return "";
}

/**
 * Mask a proxy URL down to `scheme://host:port` (creds + path dropped) so it is
 * safe to log. A malformed URL is reduced to its scheme only; an empty input
 * returns "". NEVER log a raw proxy URL — it may embed `user:pass@`.
 */
export function maskProxyUrl(proxyUrl: string): string {
	const raw = (proxyUrl ?? "").trim();
	if (!raw) return "";
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}`; // host includes :port; userinfo + path/query dropped
	} catch {
		const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1];
		return scheme ? `${scheme}://<masked>` : "<masked>";
	}
}

/** Resolve a per-account view of the config (defaults + token resolution filled in). */
export function resolveSlackAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedSlackAccount {
	const slot = slackChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	return {
		accountId: id,
		enabled,
		botToken: resolveSlackBotToken(cfg, id, env),
		appToken: resolveSlackAppToken(cfg, id, env),
		signingSecret: resolveSlackSigningSecret(cfg, id, env),
		userToken: resolveSlackUserToken(cfg, id, env),
		proxyUrl: resolveSlackProxyUrl(cfg, id, env),
		verbose: slot?.verbose === true,
	};
}

/* ───────────────────────── transport / lifecycle config ───────────────────────── */

/** Resolved Slack transport config (mode + events-API details). */
export interface SlackEventsConfig {
	/** `"socket"` (default) or `"events"`. */
	mode: "socket" | "events";
	/** Public base URL Slack POSTs to (events mode). `""` when unset. */
	url: string;
	/** Gateway route path (default `/slack/events`). */
	path: string;
}

/**
 * Resolve the Slack transport config. Defaults to `socket` (Brigade is
 * local-first and Socket Mode needs no public URL); `events` is opt-in via
 * `channels.slack.mode: "events"`.
 */
export function slackEventsConfig(cfg: BrigadeConfig): SlackEventsConfig {
	const slot = slackChannelConfig(cfg);
	const rawMode = typeof slot?.mode === "string" ? slot.mode.trim().toLowerCase() : "";
	const mode: "socket" | "events" = rawMode === "events" || rawMode === "http" ? "events" : "socket";
	const ev = slot?.events ?? {};
	const path = typeof ev.path === "string" && ev.path.trim() ? ev.path.trim() : DEFAULT_EVENTS_PATH;
	return {
		mode,
		url: typeof ev.url === "string" ? ev.url.trim() : "",
		path: path.startsWith("/") ? path : `/${path}`,
	};
}

/**
 * Normalize a path to a leading-slash, trailing-slash-stripped form so derived
 * per-account paths concatenate cleanly. `"/slack/events/"` → `"/slack/events"`.
 */
function normalizeEventsPath(raw: string): string {
	const trimmed = (raw ?? "").trim();
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

/**
 * Resolve the events-mode gateway route path for ONE account. Multi-workspace
 * installs need a DISTINCT path per workspace (Slack POSTs to a per-app URL, and
 * the gateway routes by exact path):
 *
 *   - default account → the configured base events path (`channels.slack.events.
 *     path`, default `/slack/events`) — byte-identical to the single-workspace
 *     path so an existing default-only install is unchanged.
 *   - a named account → its explicit `accounts[].webhookPath` when set
 *     (`${VAR}`-resolved), else the derived `${basePath}/<accountId>` so two
 *     workspaces can't collide on one route.
 *
 * The base path is read from `slackEventsConfig`, so a custom
 * `channels.slack.events.path` propagates to every derived per-account path.
 */
export function resolveSlackEventsPath(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const basePath = normalizeEventsPath(slackEventsConfig(cfg).path);
	if (id === DEFAULT_ACCOUNT_ID) return basePath;
	const entry = findAccountEntry(cfg, id);
	const explicit = resolveTokenRef(entry?.webhookPath as string | undefined, env);
	if (explicit) return normalizeEventsPath(explicit);
	// Derive a collision-free path from the account id (path-segment-safe slug).
	const slug = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || id;
	return `${basePath}/${slug}`;
}

/**
 * True when live reply-streaming is enabled (`channels.slack.liveStream`).
 * Default OFF — the adapter delivers one final chunked message.
 */
export function slackLiveStreamEnabled(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.liveStream === true;
}

/**
 * Resolve the streaming edit throttle in ms. Reads
 * `channels.slack.streamThrottleMs`; falls back to 1000ms (floored at 250ms by
 * the draft-stream).
 */
export function slackStreamThrottleMs(cfg: BrigadeConfig): number {
	const raw = slackChannelConfig(cfg)?.streamThrottleMs;
	return typeof raw === "number" && raw > 0 ? raw : 1000;
}

/**
 * True when reasoning surfacing is enabled (`channels.slack.surfaceReasoning`).
 * Default OFF — `<think>` reasoning is stripped from channel replies as today.
 */
export function slackSurfaceReasoning(cfg: BrigadeConfig): boolean {
	return slackChannelConfig(cfg)?.surfaceReasoning === true;
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle Slack thread sessions.
 */
export function slackThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = slackChannelConfig(cfg)?.threadIdleTtlMs;
	if (typeof raw === "number") return raw > 0 ? raw : null;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const m = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(trimmed);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = (m[2] ?? "ms").toLowerCase();
	const mult: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, ms: 1 };
	const factor = mult[unit] ?? 1;
	return n * factor;
}

export {
	CHANNEL_ID as SLACK_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as SLACK_DEFAULT_ACCOUNT_ID,
	BOT_TOKEN_ENV_VAR as SLACK_BOT_TOKEN_ENV_VAR,
	APP_TOKEN_ENV_VAR as SLACK_APP_TOKEN_ENV_VAR,
	SIGNING_SECRET_ENV_VAR as SLACK_SIGNING_SECRET_ENV_VAR,
	USER_TOKEN_ENV_VAR as SLACK_USER_TOKEN_ENV_VAR,
};
