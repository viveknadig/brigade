/**
 * Discord media helpers — inbound download + outbound upload construction.
 *
 * INBOUND: a Discord message attachment carries a public CDN `url`
 * (cdn.discordapp.com / media.discordapp.net). We GET that URL (NO auth header —
 * Discord attachment URLs are public, unlike Slack's `url_private`) and save the
 * bytes under `~/.brigade/channels/discord/media/<YYYY-MM-DD>/<id>.<ext>` so the
 * agent can `read` the attachment by path. In convex mode the cache relocates to
 * the OS cache dir (never under ~/.brigade, to respect the strict-zero guard).
 *
 * OUTBOUND: `buildDiscordAttachment` validates a local path through Brigade's
 * outbound media-path guard (so a prompt-injected "send ~/.ssh/id_rsa" can't
 * exfiltrate a secret), then returns the `{ path, name }` the connection wraps
 * in a discord.js `AttachmentBuilder`. The builder itself lives in the
 * connection (which imports discord.js); this module stays dependency-light +
 * unit-testable.
 *
 * SSRF GUARD: even though Discord URLs are public, we REQUIRE https + a Discord
 * CDN host before fetching. Without this a prompt-injected / spoofed message
 * could carry `http://169.254.169.254/…` (cloud metadata) or any attacker host
 * and Brigade would fetch it — a classic SSRF. Mirrors `slack/media.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveChannelStateDir, resolveOsCacheDir } from "../../../config/paths.js";
import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
// Channel SDK barrel — the outbound-media exfil guard + the contract types. All
// contract types come from the channel SDK barrel so the channel is built
// entirely on `../sdk.js`.
import { validateOutboundMediaPath, type InboundMediaAttachment, type OutboundMedia } from "../sdk.js";
import { resolveDiscordAttachmentKind, type DiscordAttachmentLike } from "./inbound-extras.js";

const CHANNEL_ID = "discord";

/**
 * Defensive ceiling on an inbound attachment download. Discord's own per-file
 * limit is generous (and tiered by server boost); we cap at 50 MB so a huge
 * upload can't blow out memory. Anything larger is skipped (the message still
 * reaches the agent without the attachment).
 */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Discord's attachment-CDN hosts. An inbound attachment `url` only ever points
 * at one of these — before fetching we REQUIRE https + a Discord host so a
 * spoofed message can't make Brigade fetch an arbitrary internal URL (SSRF).
 * Subdomains of these hosts are allowed.
 */
const DISCORD_CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net", "cdn.discord.com"];

/**
 * True when `rawUrl` is an https URL whose host is a Discord CDN host (or a
 * subdomain of one). Anything else (non-https, a non-Discord host, or an
 * unparseable URL) returns false so the caller refuses to fetch.
 */
export function isAllowedDiscordAttachmentUrl(rawUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	const host = parsed.hostname.toLowerCase();
	return DISCORD_CDN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** YYYY-MM-DD (UTC) bucket — stable filename grouping for grep / review. */
function dayBucket(): string {
	const d = new Date();
	const pad = (x: number) => String(x).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Derive a file extension from a Discord attachment (filename / content-type / kind). */
function extFromAttachment(att: DiscordAttachmentLike, kind: InboundMediaAttachment["kind"]): string {
	const name = (att.name ?? "").toLowerCase();
	const fromName = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).replace(/[^a-z0-9]/g, "") : "";
	if (fromName && /^[a-z0-9]+$/.test(fromName)) return fromName;
	const mime = (att.contentType ?? "").toLowerCase();
	const fromMime = mime.includes("/") ? mime.slice(mime.lastIndexOf("/") + 1).split(";")[0]?.replace(/[^a-z0-9]/g, "") : "";
	if (fromMime && /^[a-z0-9]+$/.test(fromMime)) return fromMime;
	// Sensible default by kind when nothing carried an extension.
	switch (kind) {
		case "image":
			return "png";
		case "video":
			return "mp4";
		case "voice":
			return "ogg";
		case "audio":
			return "mp3";
		default:
			return "bin";
	}
}

/** Where downloaded media lands — OS cache in convex mode, channel-state dir otherwise. */
function mediaBaseDir(): string {
	return tryGetRuntimeContext()?.mode === "convex"
		? path.join(resolveOsCacheDir(), "channels", CHANNEL_ID)
		: resolveChannelStateDir(CHANNEL_ID);
}

/**
 * Bounded retry for the transient attachment fetch. Discord's CDN occasionally
 * blips on a 5xx or a network reset; one or two quick retries turn a dropped
 * attachment into a delivered one. The caller still wraps the whole thing in a
 * try/catch that degrades to `null`, so an exhausted retry never breaks message
 * delivery. Mirrors `slack/media.ts`'s `withSlackRetry`.
 */
export async function withDiscordRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * 2 ** i));
		}
	}
	throw lastErr;
}

export interface DownloadDiscordAttachmentArgs {
	/** The Discord attachment object (from the message's `attachments`). */
	attachment: DiscordAttachmentLike;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the download. */
	fetchImpl?: typeof fetch;
	/** Logger so a failed download logs without crashing the inbound flow. */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Download one inbound Discord attachment to disk and return its normalized
 * descriptor, or `null` when it couldn't be fetched (no url / too big / network
 * error / non-Discord host). Never throws — a download glitch must not break
 * message delivery.
 */
export async function downloadDiscordAttachment(args: DownloadDiscordAttachmentArgs): Promise<InboundMediaAttachment | null> {
	const { attachment, log } = args;
	const doFetch = args.fetchImpl ?? fetch;
	const url = attachment.url || attachment.proxyURL;
	if (!url) {
		log?.("discord attachment skipped — no url", { id: attachment.id });
		return null;
	}
	// SSRF guard: REFUSE any url that isn't https on a Discord CDN host — a spoofed
	// message pointing at `http://169.254.169.254/…` (or any attacker host) must
	// never be fetched. Checked BEFORE the fetch.
	if (!isAllowedDiscordAttachmentUrl(url)) {
		log?.("discord attachment skipped — url is not an allowed Discord CDN host (SSRF guard)", { id: attachment.id });
		return null;
	}
	if (typeof attachment.size === "number" && attachment.size > MAX_BYTES) {
		log?.("discord attachment skipped — exceeds size cap", { id: attachment.id, bytes: attachment.size, cap: MAX_BYTES });
		return null;
	}
	const kind = resolveDiscordAttachmentKind(attachment);
	try {
		const res = await withDiscordRetry(async () => {
			// `redirect: "manual"` so a cross-origin 30x can't carry the request off to
			// a non-Discord host. A redirect surfaces as a non-ok response and falls
			// through to the `!r.ok` handler below.
			const r = await doFetch(url, { redirect: "manual" });
			// Retry 5xx (transient CDN blip); a 4xx falls through to the !ok handler.
			if (!r.ok && r.status >= 500) throw new Error(`discord attachment fetch failed (${r.status})`);
			return r;
		});
		if (!res.ok) {
			log?.("discord attachment download failed", { id: attachment.id, status: res.status });
			return null;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) return null;
		if (buf.length > MAX_BYTES) {
			log?.("discord attachment skipped — exceeds size cap", { id: attachment.id, bytes: buf.length, cap: MAX_BYTES });
			return null;
		}
		const dir = path.join(mediaBaseDir(), "media", dayBucket());
		mkdirSync(dir, { recursive: true });
		// attachment.id is stable; use it as the filename so the same media resolves
		// idempotently. Fall back to a timestamp.
		const baseName = (attachment.id || `discord_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
		const dest = path.join(dir, `${baseName}.${extFromAttachment(attachment, kind)}`);
		writeFileSync(dest, buf, { mode: 0o600 });
		return {
			kind,
			path: dest,
			...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
			...(attachment.name ? { fileName: attachment.name } : {}),
		};
	} catch (err) {
		log?.("discord attachment download failed", {
			id: attachment.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** The validated outbound attachment shape the connection wraps in an `AttachmentBuilder`. */
export interface DiscordOutboundAttachment {
	/** Local filesystem path (guard-validated). */
	path: string;
	/** Display filename. */
	name: string;
	/** Optional caption — sent as the message content alongside the file. */
	caption?: string;
}

/** Default outbound file extension by media kind (used when the path has none). */
function outboundExtForKind(kind: OutboundMedia["kind"]): string {
	switch (kind) {
		case "image":
			return "png";
		case "video":
			return "mp4";
		case "voice":
			return "ogg";
		case "audio":
			return "mp3";
		default:
			// document / sticker / anything else: leave extensionless (Discord falls
			// back to the content the byte-sniff detects).
			return "";
	}
}

/**
 * Validate + shape a local file for outbound upload. Runs the path through
 * Brigade's outbound media-path guard and throws a clear operator-facing error
 * when the guard refuses it (the `send_media` tool surfaces it). Returns the
 * `{ path, name, caption? }` the connection turns into a discord.js
 * `AttachmentBuilder`.
 *
 * Filename precedence: an explicit `media.fileName` wins; otherwise the path's
 * basename. When the chosen name has NO extension we append one inferred from
 * `media.kind` (image→png, video→mp4, audio→mp3, voice→ogg) so Discord detects
 * the file type instead of treating it as an opaque blob (an extensionless
 * `image` upload otherwise renders as a generic file, not an inline preview).
 */
export function buildDiscordAttachment(media: OutboundMedia): DiscordOutboundAttachment {
	const verdict = validateOutboundMediaPath(media.path);
	if (!verdict.ok) {
		throw new Error(`Discord: ${verdict.reason ?? "refusing to attach this file"}`);
	}
	let name = media.fileName || path.basename(media.path) || "file";
	// No extension on the resolved name → infer one from the media kind so Discord
	// type-detects the attachment. `path.extname` returns "" when there's no dot.
	if (!path.extname(name)) {
		const ext = outboundExtForKind(media.kind);
		if (ext) name = `${name}.${ext}`;
	}
	return {
		path: media.path,
		name,
		...(media.caption ? { caption: media.caption } : {}),
	};
}

export { MAX_BYTES as DISCORD_MEDIA_MAX_BYTES };
