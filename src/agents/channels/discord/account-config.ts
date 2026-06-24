/**
 * Discord config-shape helpers (multi-ACCOUNT aware; mirrors Slack's
 * `account-config.ts`).
 *
 * Discord needs ONE secret per account — the bot token (every Gateway login +
 * REST call uses it). Unlike Slack (bot + app + signing tokens), there is no
 * second credential: the Gateway opens a websocket with the bot token, and the
 * same token drives the REST outbound. So this module is closer to Telegram's
 * single-token shape than Slack's three-token one, but it keeps Slack's
 * multi-account discovery so an operator can run >1 bot at once.
 *
 * Two config shapes are recognised so the surface lines up with WhatsApp /
 * Telegram / Slack:
 *
 *   Legacy (single-account):
 *     channels.discord = { enabled: true, botToken: "…" }
 *
 *   Multi-account:
 *     channels.discord = {
 *       enabled: true,
 *       accounts: [
 *         { id: "main", botToken: "…AAA" },
 *         { id: "labs", botToken: "…BBB" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 *
 * Token resolution mirrors Slack/Telegram: a `${VAR}` ref expands against
 * `process.env`; otherwise the literal passes through; then a DURABLE sealed
 * token (written by `connect_channel`) is consulted so the channel survives a
 * reboot; finally the per-secret env var `DISCORD_BOT_TOKEN` is the last-resort
 * fallback. A leading `Bot ` prefix (Discord's REST scheme prefix) is stripped
 * so an operator who pasted the whole `Authorization` header still works.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { readSealedChannelToken } from "../channel-secrets.js";

const CHANNEL_ID = "discord";
const DEFAULT_ACCOUNT_ID = "default";

/** Per-secret env var consulted as a last-resort fallback. */
const BOT_TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";

/**
 * Standard proxy env vars consulted as a last-resort proxy fallback, in
 * precedence order. Lower-case wins over upper-case (curl/undici convention),
 * and a TLS-oriented `https_proxy` outranks the catch-all `ALL_PROXY`. Mirrors
 * the keys Slack/Telegram honour.
 */
const PROXY_ENV_VARS = ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] as const;

/**
 * Sealed-token key for the bot token (`channel:discord`) — the secret
 * `connect_channel` seals. The bot token is the only Discord credential, so it
 * is the one that gets the sealed-read fallback.
 */
const SEAL_KEY_BOT = CHANNEL_ID; // `channel:discord`

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Raw shape of one entry under `channels.discord.accounts`. */
interface DiscordAccountEntry {
	id?: string;
	enabled?: boolean;
	botToken?: string;
	/** Per-account proxy URL (`http(s)://[user:pass@]host:port`). `${VAR}`-resolved. */
	proxy?: string;
	[key: string]: unknown;
}

interface DiscordChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	botToken?: string;
	/**
	 * Top-level proxy URL applied to ALL accounts that don't set their own
	 * `accounts[].proxy`. Use this on networks where `discord.com` is blocked —
	 * every REST call + the Gateway websocket route through it. Form:
	 * `http(s)://[user:pass@]host:port` — HTTP(S) CONNECT proxies ONLY. The proxy
	 * is driven by undici's `ProxyAgent`, which does HTTP(S) CONNECT tunnelling
	 * and does NOT speak SOCKS, so a `socks5://` URL will not work here.
	 * `${VAR}`-resolved like `botToken`. Env fallback: `HTTPS_PROXY` / `ALL_PROXY`.
	 */
	proxy?: string;
	accounts?: DiscordAccountEntry[];
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
	/**
	 * Which inbound reaction-adds notify the agent as a turn (default `"own"`):
	 *   - `"off"`       — never (reactions are ignored entirely);
	 *   - `"own"`       — only reactions on a message the BOT itself authored;
	 *   - `"all"`       — every reaction-add (legacy behavior);
	 *   - `"allowlist"` — only reactions from a sender on the channel allow-list.
	 * A stranger spamming reactions in an admitted channel no longer wakes the agent.
	 */
	reactionNotifications?: DiscordReactionNotificationMode;
	[key: string]: unknown;
}

/** Reaction-notification gating modes (see `channels.discord.reactionNotifications`). */
export type DiscordReactionNotificationMode = "off" | "own" | "all" | "allowlist";

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedDiscordAccount {
	accountId: string;
	enabled: boolean;
	/** Bot token, fully resolved (Bot-prefix stripped), or `""` when unset. */
	botToken: string;
	/**
	 * Proxy URL all Discord REST calls + the Gateway websocket route through,
	 * fully resolved (`${VAR}` + env fallback applied), or `""` for a direct
	 * connection (the default).
	 */
	proxyUrl: string;
	verbose: boolean;
}

/** Read `channels.discord` loosely (schema keeps it open). */
function discordChannelConfig(cfg: BrigadeConfig): DiscordChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, DiscordChannelConfigSlot> }).channels?.[CHANNEL_ID];
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

/**
 * Strip a leading `Bot ` scheme prefix from a Discord token. Discord's REST
 * `Authorization` header is `Bot <token>`; an operator who pasted the whole
 * header still gets a clean token. Idempotent + case-insensitive.
 */
export function stripBotPrefix(token: string): string {
	return token.replace(/^Bot\s+/i, "").trim();
}

/** Is the Discord channel switched on at all (any shape)? */
export function discordChannelEnabled(cfg: BrigadeConfig): boolean {
	return discordChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listDiscordAccountIds(cfg: BrigadeConfig): string[] {
	const slot = discordChannelConfig(cfg);
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
function findAccountEntry(cfg: BrigadeConfig, accountId: string): DiscordAccountEntry | null {
	const slot = discordChannelConfig(cfg);
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
 * Resolve the Discord bot token for an account. Precedence (mirrors Slack's
 * token resolution): per-account config `${VAR}`/literal → top-level config →
 * durable sealed token → per-secret env var. The `Bot ` scheme prefix is
 * stripped from whichever source wins. Returns `""` when nothing resolves.
 */
export function resolveDiscordBotToken(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = discordChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.botToken, env);
	if (perAccount) return stripBotPrefix(perAccount);
	const topLevel = resolveTokenRef(slot?.botToken, env);
	if (topLevel) return stripBotPrefix(topLevel);
	const sealed = readSealedChannelToken(SEAL_KEY_BOT);
	if (sealed) return stripBotPrefix(sealed);
	const fromEnv = (env[BOT_TOKEN_ENV_VAR] ?? "").trim();
	if (fromEnv) return stripBotPrefix(fromEnv);
	return "";
}

/**
 * Resolve the proxy URL all Discord REST calls (+ the Gateway websocket) should
 * route through. Precedence (mirrors Slack's `resolveSlackProxyUrl`):
 *   1. The per-account `accounts[].proxy` (multi-account shape), `${VAR}`-resolved.
 *   2. The top-level `channels.discord.proxy`, `${VAR}`-resolved.
 *   3. The first set standard proxy env var (`https_proxy` / `HTTPS_PROXY` /
 *      `all_proxy` / `ALL_PROXY`) — last-resort fallback.
 * Returns `""` when none is configured → a DIRECT connection (the default).
 *
 * `${VAR}` refs are resolved here the same way `botToken` is, so an operator can
 * keep the proxy (which may carry `user:pass@` creds) out of the committed
 * config as `channels.discord.proxy: "${DISCORD_PROXY}"`.
 */
export function resolveDiscordProxyUrl(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = discordChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveTokenRef(entry?.proxy, env);
	if (perAccount) return perAccount;
	const topLevel = resolveTokenRef(slot?.proxy, env);
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
export function resolveDiscordAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedDiscordAccount {
	const slot = discordChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	return {
		accountId: id,
		enabled,
		botToken: resolveDiscordBotToken(cfg, id, env),
		proxyUrl: resolveDiscordProxyUrl(cfg, id, env),
		verbose: slot?.verbose === true,
	};
}

/* ───────────────────────── lifecycle / streaming config ───────────────────────── */

/**
 * True when live reply-streaming is enabled (`channels.discord.liveStream`).
 * Default OFF — the adapter delivers one final chunked message.
 */
export function discordLiveStreamEnabled(cfg: BrigadeConfig): boolean {
	return discordChannelConfig(cfg)?.liveStream === true;
}

/**
 * Resolve the streaming edit throttle in ms. Reads
 * `channels.discord.streamThrottleMs`; falls back to 1000ms (floored at 250ms by
 * the draft-stream).
 */
export function discordStreamThrottleMs(cfg: BrigadeConfig): number {
	const raw = discordChannelConfig(cfg)?.streamThrottleMs;
	return typeof raw === "number" && raw > 0 ? raw : 1000;
}

/**
 * True when reasoning surfacing is enabled (`channels.discord.surfaceReasoning`).
 * Default OFF — `<think>` reasoning is stripped from channel replies as today.
 */
export function discordSurfaceReasoning(cfg: BrigadeConfig): boolean {
	return discordChannelConfig(cfg)?.surfaceReasoning === true;
}

/**
 * Resolve the reaction-notification mode (`channels.discord.reactionNotifications`).
 * Defaults to `"own"` (only reactions on the bot's own messages wake the agent) so
 * a stranger's reaction in an admitted channel no longer spams a turn. An invalid /
 * unset value degrades to the `"own"` default.
 */
export function discordReactionNotifications(cfg: BrigadeConfig): DiscordReactionNotificationMode {
	const raw = discordChannelConfig(cfg)?.reactionNotifications;
	if (raw === "off" || raw === "own" || raw === "all" || raw === "allowlist") return raw;
	return "own";
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle Discord thread sessions.
 */
export function discordThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = discordChannelConfig(cfg)?.threadIdleTtlMs;
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
	CHANNEL_ID as DISCORD_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as DISCORD_DEFAULT_ACCOUNT_ID,
	BOT_TOKEN_ENV_VAR as DISCORD_BOT_TOKEN_ENV_VAR,
};
