/**
 * Slack media helpers — inbound download + outbound upload construction.
 *
 * INBOUND: Slack doesn't push file bytes; a message event carries file objects
 * with an authenticated `url_private`. To get the bytes we GET that URL with an
 * `Authorization: Bearer <botToken>` header (a plain fetch returns the login
 * HTML otherwise). Bytes are saved under
 * `~/.brigade/channels/slack/media/<YYYY-MM-DD>/<fileId>.<ext>` so the agent can
 * `read` the attachment by path. In convex mode the cache relocates to the OS
 * cache dir (never under ~/.brigade, to respect the strict-zero guard).
 *
 * OUTBOUND: `uploadSlackFile` posts a local path's bytes via the Web API's
 * `files.uploadV2`, after running the path through Brigade's outbound media-path
 * guard so a prompt-injected "send ~/.ssh/id_rsa" can't exfiltrate a secret. The
 * `@slack/web-api` `WebClient` is injected (not imported here) so this module
 * stays dependency-light + unit-testable.
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveChannelStateDir, resolveOsCacheDir } from "../../../config/paths.js";
import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
// Channel SDK barrel — the outbound-media exfil guard + the contract types.
// All contract types come from the channel SDK barrel so the channel is built
// entirely on `../sdk.js`.
import {
	validateOutboundMediaPath,
	type InboundMediaAttachment,
	type OutboundMedia,
} from "../sdk.js";
import { resolveSlackFileKind, type SlackFileObject } from "./inbound-extras.js";

const CHANNEL_ID = "slack";

/**
 * Defensive ceiling on an inbound file download. Slack's own per-file limit is
 * generous; we cap at 50 MB so a huge upload can't blow out memory. Anything
 * larger is skipped (the message still reaches the agent without the
 * attachment).
 */
const MAX_BYTES = 50 * 1024 * 1024;

/** YYYY-MM-DD (UTC) bucket — stable filename grouping for grep / review. */
function dayBucket(): string {
	const d = new Date();
	const pad = (x: number) => String(x).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Derive a file extension from a Slack file object (filetype / name / kind). */
function extFromFile(file: SlackFileObject, kind: InboundMediaAttachment["kind"]): string {
	const type = (file.filetype ?? "").toLowerCase();
	if (type && /^[a-z0-9]+$/.test(type)) return type;
	const fromName = path.extname(file.name ?? "").replace(/^\./, "").toLowerCase();
	if (fromName && /^[a-z0-9]+$/.test(fromName)) return fromName;
	// Sensible default by kind when nothing carried an extension.
	switch (kind) {
		case "image":
			return "png";
		case "video":
			return "mp4";
		case "voice":
			return "m4a";
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
 * Bounded retry for the transient file fetch. Slack's file CDN occasionally
 * blips on a 5xx or a network reset; one or two quick retries turn a dropped
 * attachment into a delivered one. The caller still wraps the whole thing in a
 * try/catch that degrades to `null`, so an exhausted retry never breaks message
 * delivery. Mirrors Telegram's `withMediaRetry`.
 */
export async function withSlackRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
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

export interface DownloadSlackFileArgs {
	/** The Slack file object (from the message event's `files[]`). */
	file: SlackFileObject;
	/** Bot (or user) token — sent as `Authorization: Bearer …`. NEVER logged. */
	token: string;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the download. */
	fetchImpl?: typeof fetch;
	/** Logger so a failed download logs without crashing the inbound flow. */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Download one inbound Slack file to disk and return its normalized descriptor,
 * or `null` when the file couldn't be fetched (no url / too big / network error
 * / tombstoned). Never throws — a download glitch must not break message
 * delivery. The `Authorization: Bearer` header is REQUIRED; a plain GET of
 * `url_private` returns Slack's HTML login page, not the bytes.
 */
export async function downloadSlackFile(args: DownloadSlackFileArgs): Promise<InboundMediaAttachment | null> {
	const { file, token, log } = args;
	const doFetch = args.fetchImpl ?? fetch;
	const url = file.url_private_download || file.url_private;
	if (!url) {
		log?.("slack file skipped — no private url", { fileId: file.id });
		return null;
	}
	if (typeof file.size === "number" && file.size > MAX_BYTES) {
		log?.("slack file skipped — exceeds size cap", { fileId: file.id, bytes: file.size, cap: MAX_BYTES });
		return null;
	}
	const kind = resolveSlackFileKind(file);
	try {
		const res = await withSlackRetry(async () => {
			const r = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
			// Retry 5xx (transient server/CDN blip); a 4xx falls through to the !ok
			// handler below (no point retrying a permanent client error).
			if (!r.ok && r.status >= 500) throw new Error(`slack file fetch failed (${r.status})`);
			return r;
		});
		if (!res.ok) {
			log?.("slack file download failed", { fileId: file.id, status: res.status });
			return null;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) return null;
		if (buf.length > MAX_BYTES) {
			log?.("slack file skipped — exceeds size cap", { fileId: file.id, bytes: buf.length, cap: MAX_BYTES });
			return null;
		}
		const dir = path.join(mediaBaseDir(), "media", dayBucket());
		mkdirSync(dir, { recursive: true });
		// file.id is stable across re-deliveries; use it as the filename so the same
		// media resolves idempotently. Fall back to a timestamp.
		const baseName = (file.id || `slack_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "_");
		const dest = path.join(dir, `${baseName}.${extFromFile(file, kind)}`);
		writeFileSync(dest, buf, { mode: 0o600 });
		return {
			kind,
			path: dest,
			...(file.mimetype ? { mimeType: file.mimetype } : {}),
			...(file.name ? { fileName: file.name } : {}),
			...(file.title ? { caption: file.title } : {}),
		};
	} catch (err) {
		log?.("slack file download failed", {
			fileId: file.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** The minimal `files.uploadV2` surface the outbound path drives — injectable for tests. */
export interface SlackUploadApi {
	files: {
		uploadV2(args: {
			channel_id: string;
			file: unknown;
			filename: string;
			initial_comment?: string;
			thread_ts?: string;
		}): Promise<unknown>;
	};
}

export interface UploadSlackFileArgs {
	/** The Web API client (`WebClient`) the upload runs through. */
	client: SlackUploadApi;
	/** Destination channel id. */
	channelId: string;
	/** The local media to upload. */
	media: OutboundMedia;
	/** Optional thread to upload into. */
	threadId?: string;
}

/**
 * Upload a local file (image / video / audio / doc) to a Slack channel via
 * `files.uploadV2`, after running the path through Brigade's outbound
 * media-path guard. Throws a clear operator-facing error when the guard refuses
 * the path (the `send_media` tool surfaces it). The file is streamed from disk;
 * the caption rides as `initial_comment`.
 */
export async function uploadSlackFile(args: UploadSlackFileArgs): Promise<void> {
	const { media } = args;
	const verdict = validateOutboundMediaPath(media.path);
	if (!verdict.ok) {
		throw new Error(`Slack: ${verdict.reason ?? "refusing to attach this file"}`);
	}
	const filename = media.fileName || path.basename(media.path) || "file";
	await args.client.files.uploadV2({
		channel_id: args.channelId,
		file: createReadStream(media.path),
		filename,
		...(media.caption ? { initial_comment: media.caption } : {}),
		...(args.threadId ? { thread_ts: args.threadId } : {}),
	});
}

export { MAX_BYTES as SLACK_MEDIA_MAX_BYTES };
