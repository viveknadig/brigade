/**
 * iMessage config-shape helpers (multi-ACCOUNT aware; mirrors Discord's
 * `account-config.ts`).
 *
 * iMessage is driven through the third-party `imsg` CLI run as a long-lived
 * JSON-RPC subprocess (`imsg rpc`). Unlike a token-based channel there is NO
 * secret to seal — the auth surface is "the machine running the gateway is
 * already signed into Messages.app". So instead of a bot token this module
 * resolves the local-runtime knobs the transport needs:
 *
 *   - `cliPath`       path to the `imsg` binary (default `"imsg"`, found on PATH).
 *   - `dbPath`        optional override for the chat.db the binary reads.
 *   - `service`       default send service: `"imessage"` | `"sms"` | `"auto"`.
 *   - `region`        default phone-number region for E.164 normalisation (US).
 *   - `mediaMaxMb`    cap on an outbound attachment's size (MB).
 *   - `probeTimeoutMs` RPC round-trip timeout for the doctor/probe call.
 *   - `attachmentRoots` allow-list of dirs inbound media may be read from.
 *
 * Two config shapes are recognised so the surface lines up with the other
 * channels:
 *
 *   Legacy (single-account):
 *     channels.imessage = { enabled: true, cliPath: "imsg", service: "auto" }
 *
 *   Multi-account:
 *     channels.imessage = {
 *       enabled: true,
 *       accounts: [
 *         { id: "personal", dbPath: "~/Library/Messages/chat.db" },
 *         { id: "work",     cliPath: "/opt/imsg/bin/imsg" },
 *       ],
 *     }
 *
 * A legacy config with no `accounts[]` reads as `[{ id: "default" }]`.
 */

import type { BrigadeConfig } from "../../../config/io.js";

/** Canonical channel id + default account id. */
const CHANNEL_ID = "imessage";
const DEFAULT_ACCOUNT_ID = "default";

/** Default `imsg` binary name — resolved on PATH when no explicit path is set. */
const DEFAULT_CLI_PATH = "imsg";
/** Default send service when neither the target nor the account pins one. */
const DEFAULT_SERVICE: IMessageService = "auto";
/** Default phone-number region used for E.164 normalisation. */
const DEFAULT_REGION = "US";
/** Default outbound media size cap (MB). */
const DEFAULT_MEDIA_MAX_MB = 16;
/** Default RPC probe / request timeout (ms). */
export const DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS = 10_000;
/** Default per-message outbound text chunk size (chars). iMessage's practical limit. */
export const DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT = 4_000;
/**
 * Default rolling-history depth for an untagged GROUP message (0 = off). iMessage
 * delivers one notification per message with no thread context, so the monitor
 * keeps the last N seen group messages and prepends them as context.
 */
export const DEFAULT_IMESSAGE_HISTORY_LIMIT = 0;

/** Default macOS Messages attachment root inbound media may be read from. */
export const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS: readonly string[] = [
	"/Users/*/Library/Messages/Attachments",
];

/** Per-knob env var consulted as a last-resort fallback for the binary path. */
const CLI_PATH_ENV_VAR = "IMSG_CLI_PATH";

/** `${VAR}` secret-ref form — identical to `config/io.ts`'s SECRET_REF_PATTERN. */
const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/** Outbound send service. `auto` lets the bridge pick iMessage vs SMS. */
export type IMessageService = "imessage" | "sms" | "auto";

/** Outbound chunk strategy. `length` = pack to the char limit (default); `newline` = prefer line breaks. */
export type IMessageChunkMode = "length" | "newline";

/** Raw shape of one entry under `channels.imessage.accounts`. */
interface IMessageAccountEntry {
	id?: string;
	enabled?: boolean;
	cliPath?: string;
	dbPath?: string;
	service?: string;
	region?: string;
	mediaMaxMb?: number;
	probeTimeoutMs?: number;
	attachmentRoots?: string[];
	remoteAttachmentRoots?: string[];
	remoteHost?: string;
	selfHandle?: string;
	includeAttachments?: boolean;
	defaultTo?: string;
	historyLimit?: number;
	dmHistoryLimit?: number;
	textChunkLimit?: number;
	chunkMode?: string;
	[key: string]: unknown;
}

interface IMessageChannelConfigSlot {
	enabled?: boolean;
	verbose?: boolean;
	cliPath?: string;
	dbPath?: string;
	service?: string;
	region?: string;
	mediaMaxMb?: number;
	probeTimeoutMs?: number;
	attachmentRoots?: string[];
	remoteAttachmentRoots?: string[];
	remoteHost?: string;
	selfHandle?: string;
	includeAttachments?: boolean;
	defaultTo?: string;
	historyLimit?: number;
	dmHistoryLimit?: number;
	textChunkLimit?: number;
	chunkMode?: string;
	accounts?: IMessageAccountEntry[];
	/** Idle TTL (ms / duration string) after which idle thread sessions are reaped. */
	threadIdleTtlMs?: number | string;
	[key: string]: unknown;
}

/** Resolved per-account info — what the adapter runtime reads. */
export interface ResolvedIMessageAccount {
	accountId: string;
	enabled: boolean;
	/** `imsg` binary path (default `"imsg"`). */
	cliPath: string;
	/** Optional chat.db override (`~`-expansion done by the client). */
	dbPath: string;
	/** Default send service for this account. */
	service: IMessageService;
	/** Default phone-number region (E.164 normalisation). */
	region: string;
	/** Outbound media size cap (bytes). */
	mediaMaxBytes: number;
	/** RPC probe / request timeout (ms). */
	probeTimeoutMs: number;
	/**
	 * The bot's OWN iMessage handle (normalised — digits for a phone, lower-case
	 * for an email). When set, a group message whose text names this handle gets a
	 * populated `mentions[]` so the central pipeline's group requireMention gate
	 * can fire. Empty when unset (group mention-gating then can't match the bot).
	 */
	selfHandle: string;
	/**
	 * Remote host (`user@host` / `host`) when the `imsg` bridge runs on a DIFFERENT
	 * machine than the gateway. When set, inbound attachments are SCP-copied from
	 * the remote root to a local temp before resolution. Empty for a same-host setup.
	 */
	remoteHost: string;
	/** When false, skip inbound media resolution entirely (text-only ingest). Default true. */
	includeAttachments: boolean;
	/** Default outbound recipient when a send omits an explicit target. Empty when unset. */
	defaultTo: string;
	/** Rolling-history depth for an untagged GROUP message (0 = off). */
	historyLimit: number;
	/** Rolling-history depth for an untagged DM (0 = off). */
	dmHistoryLimit: number;
	/** Per-message outbound text chunk size (chars). */
	textChunkLimit: number;
	/** Outbound chunk strategy. */
	chunkMode: IMessageChunkMode;
	verbose: boolean;
}

/** Read `channels.imessage` loosely (schema keeps it open). */
function imessageChannelConfig(cfg: BrigadeConfig): IMessageChannelConfigSlot | undefined {
	return (cfg as { channels?: Record<string, IMessageChannelConfigSlot> }).channels?.[CHANNEL_ID];
}

/**
 * Resolve a single string-ish config value: a `${VAR}` ref expands against
 * `process.env`; any other non-empty string passes through verbatim; empty /
 * missing returns "".
 */
function resolveStringRef(raw: string | undefined, env: NodeJS.ProcessEnv): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const m = SECRET_REF_PATTERN.exec(trimmed);
	if (m && m[1]) return (env[m[1]] ?? "").trim();
	return trimmed;
}

/** Coerce a loose `service` string to the typed union (defaults to `auto`). */
export function coerceIMessageService(raw: unknown, fallback: IMessageService = DEFAULT_SERVICE): IMessageService {
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (v === "imessage" || v === "sms" || v === "auto") return v;
	return fallback;
}

/** Is the iMessage channel switched on at all (any shape)? */
export function imessageChannelEnabled(cfg: BrigadeConfig): boolean {
	return imessageChannelConfig(cfg)?.enabled === true;
}

/** List configured account ids. Legacy single-account configs surface `["default"]`. */
export function listIMessageAccountIds(cfg: BrigadeConfig): string[] {
	const slot = imessageChannelConfig(cfg);
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
function findAccountEntry(cfg: BrigadeConfig, accountId: string): IMessageAccountEntry | null {
	const slot = imessageChannelConfig(cfg);
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
 * Resolve the `imsg` binary path for an account. Precedence: per-account config
 * `${VAR}`/literal → top-level config → `IMSG_CLI_PATH` env → the default
 * `"imsg"` (found on PATH).
 */
export function resolveIMessageCliPath(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveStringRef(entry?.cliPath, env);
	if (perAccount) return perAccount;
	const topLevel = resolveStringRef(slot?.cliPath, env);
	if (topLevel) return topLevel;
	const fromEnv = (env[CLI_PATH_ENV_VAR] ?? "").trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_CLI_PATH;
}

/**
 * Resolve the optional chat.db override for an account. Per-account → top-level
 * → "" (the binary uses its own default location). `~`-expansion is the client's
 * job — this returns the raw path.
 */
export function resolveIMessageDbPath(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const perAccount = resolveStringRef(entry?.dbPath, env);
	if (perAccount) return perAccount;
	const topLevel = resolveStringRef(slot?.dbPath, env);
	if (topLevel) return topLevel;
	return "";
}

/** Merge inbound attachment-root allow-lists in priority order, de-duped. */
function mergeRoots(...lists: Array<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			const v = typeof raw === "string" ? raw.trim() : "";
			if (!v || seen.has(v)) continue;
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/**
 * Resolve the inbound attachment roots iMessage media may be read from
 * (account-specific → channel-global → the macOS Messages Attachments floor).
 */
export function resolveIMessageAttachmentRoots(cfg: BrigadeConfig, accountId?: string | null): string[] {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return mergeRoots(entry?.attachmentRoots, slot?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}

/**
 * Resolve the REMOTE inbound attachment roots (when the `imsg` bridge runs on a
 * different host than the gateway). Falls back through the local roots so a
 * same-host setup is unchanged.
 */
export function resolveIMessageRemoteAttachmentRoots(cfg: BrigadeConfig, accountId?: string | null): string[] {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return mergeRoots(
		entry?.remoteAttachmentRoots,
		slot?.remoteAttachmentRoots,
		entry?.attachmentRoots,
		slot?.attachmentRoots,
		DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
	);
}

/** Resolve the RPC probe / request timeout (ms) for an account. */
export function resolveIMessageProbeTimeoutMs(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = typeof entry?.probeTimeoutMs === "number" ? entry.probeTimeoutMs : slot?.probeTimeoutMs;
	return typeof raw === "number" && raw > 0 ? raw : DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
}

/**
 * Normalise a handle for self/mention matching: an email lower-cases; a phone
 * keeps only its digits (so `+1 (555) 123-4567` and `15551234567` compare equal).
 * Returns "" for an empty input. Mirrors BlueBubbles' `normalizeBlueBubblesSelfHandle`.
 */
export function normalizeIMessageSelfHandle(raw: string | undefined): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	if (trimmed.includes("@")) return trimmed.toLowerCase();
	const digits = trimmed.replace(/[^0-9]/g, "");
	return digits || trimmed.toLowerCase();
}

/**
 * Resolve the bot's own handle for an account (per-account `selfHandle` wins over
 * the top-level slot), normalised. Empty when unset.
 */
export function resolveIMessageSelfHandle(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = resolveStringRef(entry?.selfHandle, env) || resolveStringRef(slot?.selfHandle, env);
	return normalizeIMessageSelfHandle(raw);
}

/**
 * Resolve the REMOTE host (`user@host` / `host`) for an account when the `imsg`
 * bridge runs on a different machine. Per-account → top-level → "". Returns the
 * raw configured value; the SCP layer safety-validates it.
 */
export function resolveIMessageRemoteHost(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return resolveStringRef(entry?.remoteHost, env) || resolveStringRef(slot?.remoteHost, env);
}

/**
 * Resolve whether inbound media should be resolved at all. Per-account →
 * top-level → DEFAULT TRUE (resolve media). Setting `includeAttachments:false`
 * opts a noisy / privacy-sensitive account out of inbound media resolution.
 */
export function resolveIMessageIncludeAttachments(cfg: BrigadeConfig, accountId?: string | null): boolean {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	if (typeof entry?.includeAttachments === "boolean") return entry.includeAttachments;
	if (typeof slot?.includeAttachments === "boolean") return slot.includeAttachments;
	return true;
}

/** Resolve the default outbound recipient (per-account → top-level → ""). */
export function resolveIMessageDefaultTo(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return resolveStringRef(entry?.defaultTo, env) || resolveStringRef(slot?.defaultTo, env);
}

/** Coerce a non-negative integer history limit (per-account → top-level → fallback). */
function resolveHistoryLimit(
	entryVal: unknown,
	slotVal: unknown,
	fallback: number,
): number {
	const pick = typeof entryVal === "number" ? entryVal : typeof slotVal === "number" ? slotVal : fallback;
	return Number.isFinite(pick) && pick > 0 ? Math.floor(pick) : 0;
}

/** Resolve the rolling-history depth for an untagged GROUP message (0 = off). */
export function resolveIMessageHistoryLimit(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return resolveHistoryLimit(entry?.historyLimit, slot?.historyLimit, DEFAULT_IMESSAGE_HISTORY_LIMIT);
}

/** Resolve the rolling-history depth for an untagged DM (0 = off). */
export function resolveIMessageDmHistoryLimit(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return resolveHistoryLimit(entry?.dmHistoryLimit, slot?.dmHistoryLimit, DEFAULT_IMESSAGE_HISTORY_LIMIT);
}

/** Resolve the per-message outbound text chunk size (chars). */
export function resolveIMessageTextChunkLimit(cfg: BrigadeConfig, accountId?: string | null): number {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	const raw = typeof entry?.textChunkLimit === "number" ? entry.textChunkLimit : slot?.textChunkLimit;
	return typeof raw === "number" && raw > 0 ? Math.floor(raw) : DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT;
}

/** Coerce a loose `chunkMode` string to the typed union (defaults to `length`). */
export function coerceIMessageChunkMode(raw: unknown): IMessageChunkMode {
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return v === "newline" ? "newline" : "length";
}

/** Resolve the outbound chunk strategy (per-account → top-level → `length`). */
export function resolveIMessageChunkMode(cfg: BrigadeConfig, accountId?: string | null): IMessageChunkMode {
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const slot = imessageChannelConfig(cfg);
	const entry = findAccountEntry(cfg, id);
	return coerceIMessageChunkMode(entry?.chunkMode ?? slot?.chunkMode);
}

/** Resolve a per-account view of the config (defaults filled in). */
export function resolveIMessageAccount(
	cfg: BrigadeConfig,
	accountId?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedIMessageAccount {
	const slot = imessageChannelConfig(cfg);
	const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
	const entry = findAccountEntry(cfg, id);
	const enabled = entry?.enabled !== false && slot?.enabled === true;
	const service = coerceIMessageService(
		entry?.service ?? slot?.service,
		DEFAULT_SERVICE,
	);
	const region = (resolveStringRef(entry?.region, env) || resolveStringRef(slot?.region, env) || DEFAULT_REGION).trim();
	const mediaMaxMb =
		typeof entry?.mediaMaxMb === "number" && entry.mediaMaxMb > 0
			? entry.mediaMaxMb
			: typeof slot?.mediaMaxMb === "number" && slot.mediaMaxMb > 0
				? slot.mediaMaxMb
				: DEFAULT_MEDIA_MAX_MB;
	return {
		accountId: id,
		enabled,
		cliPath: resolveIMessageCliPath(cfg, id, env),
		dbPath: resolveIMessageDbPath(cfg, id, env),
		service,
		region,
		mediaMaxBytes: Math.round(mediaMaxMb * 1024 * 1024),
		probeTimeoutMs: resolveIMessageProbeTimeoutMs(cfg, id),
		selfHandle: resolveIMessageSelfHandle(cfg, id, env),
		remoteHost: resolveIMessageRemoteHost(cfg, id, env),
		includeAttachments: resolveIMessageIncludeAttachments(cfg, id),
		defaultTo: resolveIMessageDefaultTo(cfg, id, env),
		historyLimit: resolveIMessageHistoryLimit(cfg, id),
		dmHistoryLimit: resolveIMessageDmHistoryLimit(cfg, id),
		textChunkLimit: resolveIMessageTextChunkLimit(cfg, id),
		chunkMode: resolveIMessageChunkMode(cfg, id),
		verbose: slot?.verbose === true,
	};
}

/**
 * Resolve the idle-thread-session TTL in ms, or `null` when unset / disabled.
 * Accepts a number (ms) or a duration string (`"6h"`, `"30m"`, …). The cron
 * session-reaper uses this to age out idle iMessage group sessions.
 */
export function imessageThreadIdleTtlMs(cfg: BrigadeConfig): number | null {
	const raw = imessageChannelConfig(cfg)?.threadIdleTtlMs;
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
	CHANNEL_ID as IMESSAGE_CHANNEL_ID,
	DEFAULT_ACCOUNT_ID as IMESSAGE_DEFAULT_ACCOUNT_ID,
	CLI_PATH_ENV_VAR as IMESSAGE_CLI_PATH_ENV_VAR,
	DEFAULT_CLI_PATH as IMESSAGE_DEFAULT_CLI_PATH,
};
