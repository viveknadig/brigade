/**
 * BlueBubbles media helpers — inbound download + cache, outbound resolution.
 *
 * Unlike the native `imessage` channel (where the `imsg` bridge has already
 * saved inbound bytes to local disk), BlueBubbles serves attachments over HTTP:
 * `GET /api/v1/attachment/{guid}/download`. So this module DOWNLOADS each inbound
 * attachment to a per-account cache dir under the OS cache (outside `~/.brigade`),
 * applying a small extension-normalisation map (HEIC→jpg, caf→mp3) so the agent's
 * `read` tool + downstream tools see a friendlier extension.
 *
 * OUTBOUND resolution reuses the iMessage exfil guard + kind classifiers so a
 * prompt-injected "send ~/.ssh/id_rsa" can't attach a secret.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { kindFromExt, kindFromMime, resolveOutboundAttachment, inferOutboundMediaKind } from "../imessage/media.js";
import {
	blueBubblesFetchWithTimeout,
	buildBlueBubblesApiUrl,
	type FetchLike,
} from "./types.js";
import type { InboundMediaAttachment } from "../sdk.js";

// Re-export the shared classifiers so callers import them from one place.
export { kindFromExt, kindFromMime, resolveOutboundAttachment, inferOutboundMediaKind };

/**
 * Inbound extension-normalisation map. iMessage delivers Apple-native container
 * formats that most tools can't open; map them to a friendlier extension on
 * download. The bytes are NOT transcoded — only the on-disk extension is changed
 * (a HEIC renamed `.jpg` is still HEIC bytes, but the friendlier extension keeps
 * downstream readers from choking on the `.heic` suffix).
 */
const EXTENSION_MAP: Record<string, string> = {
	heic: "jpg",
	heif: "jpg",
	caf: "mp3",
};

/** Apply the inbound extension map to a filename (`photo.heic` → `photo.jpg`). */
export function mapInboundExtension(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase().replace(/^\./, "");
	const mapped = EXTENSION_MAP[ext];
	if (!mapped) return fileName;
	const stem = fileName.slice(0, fileName.length - (ext.length + 1));
	return `${stem || "attachment"}.${mapped}`;
}

/** One raw inbound attachment as the BlueBubbles webhook reports it. */
export interface RawBlueBubblesAttachment {
	guid?: string;
	transferName?: string;
	mimeType?: string;
	totalBytes?: number;
}

/** Args for downloading + caching inbound attachments. */
export interface DownloadInboundArgs {
	serverUrl: string;
	password: string;
	/** Per-account cache dir the bytes are written under. */
	cacheDir: string;
	/** Max bytes to accept per attachment (skips oversize ones). */
	maxBytes: number;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
}

/**
 * Download + cache a single inbound attachment by GUID, returning the saved
 * `InboundMediaAttachment` (or null when it has no GUID / is oversize / fails).
 * The saved filename runs through `mapInboundExtension`.
 */
export async function downloadBlueBubblesAttachment(
	att: RawBlueBubblesAttachment,
	args: DownloadInboundArgs,
): Promise<InboundMediaAttachment | null> {
	const guid = (att.guid ?? "").trim();
	if (!guid) return null;
	if (args.maxBytes > 0 && typeof att.totalBytes === "number" && att.totalBytes > args.maxBytes) return null;
	const url = buildBlueBubblesApiUrl({
		serverUrl: args.serverUrl,
		path: `attachment/${encodeURIComponent(guid)}/download`,
		password: args.password,
	});
	let bytes: Uint8Array;
	let contentType: string | undefined;
	try {
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{ timeoutMs: args.timeoutMs ?? 30_000, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}), ...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}) },
		);
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		bytes = new Uint8Array(buf);
		if (args.maxBytes > 0 && bytes.byteLength > args.maxBytes) return null;
		const ct = res.headers.get("content-type");
		contentType = ct ? ct.split(";")[0]?.trim() || undefined : undefined;
	} catch {
		return null;
	}
	const rawName = (att.transferName ?? "").trim() || `${guid}`;
	const fileName = mapInboundExtension(rawName);
	const dest = path.join(args.cacheDir, `${guid}-${fileName}`);
	try {
		await mkdir(args.cacheDir, { recursive: true });
		await writeFile(dest, bytes);
	} catch {
		return null;
	}
	const mimeType = (att.mimeType ?? contentType ?? "").trim() || undefined;
	return {
		kind: mimeType ? kindFromMime(mimeType) : kindFromExt(fileName),
		path: dest,
		...(mimeType ? { mimeType } : {}),
		fileName,
	};
}

/**
 * Download all inbound attachments for a message, dropping any that fail / are
 * oversize. Returns [] when none resolve.
 */
export async function downloadInboundAttachments(
	raw: RawBlueBubblesAttachment[] | null | undefined,
	args: DownloadInboundArgs,
): Promise<InboundMediaAttachment[]> {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const out: InboundMediaAttachment[] = [];
	for (const att of raw) {
		const resolved = await downloadBlueBubblesAttachment(att, args);
		if (resolved) out.push(resolved);
	}
	return out;
}

/** Pull the raw attachment descriptors out of a `message/{guid}` response record. */
function extractAttachmentsFromMessage(data: unknown): RawBlueBubblesAttachment[] {
	const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
	const raw = rec?.attachments;
	if (!Array.isArray(raw)) return [];
	const out: RawBlueBubblesAttachment[] = [];
	for (const a of raw) {
		const r = a && typeof a === "object" ? (a as Record<string, unknown>) : null;
		const guid = typeof r?.guid === "string" ? r.guid.trim() : "";
		if (!guid) continue;
		const transferName =
			(typeof r?.transferName === "string" && r.transferName) ||
			(typeof r?.transfer_name === "string" && r.transfer_name) ||
			undefined;
		const mimeType =
			(typeof r?.mimeType === "string" && r.mimeType) ||
			(typeof r?.mime_type === "string" && r.mime_type) ||
			(typeof r?.uti === "string" && r.uti) ||
			undefined;
		const totalBytes =
			(typeof r?.totalBytes === "number" && r.totalBytes) ||
			(typeof r?.total_bytes === "number" && r.total_bytes) ||
			undefined;
		out.push({
			guid,
			...(transferName ? { transferName } : {}),
			...(mimeType ? { mimeType } : {}),
			...(totalBytes !== undefined ? { totalBytes } : {}),
		});
	}
	return out;
}

/** Args for the late-index attachment re-fetch. */
export interface FetchMessageAttachmentsArgs {
	serverUrl: string;
	password: string;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	allowPrivateNetwork?: boolean;
}

/**
 * Re-fetch a message's attachment descriptors by GUID
 * (`GET /api/v1/message/{guid}?with=attachment`).
 *
 * BlueBubbles can fire the `new-message` webhook BEFORE attachment indexing
 * finishes, so the webhook's `attachments` arrives empty for a message that
 * actually has media. A short delay + this single re-fetch recovers the media
 * that would otherwise be silently lost. Returns [] on any failure (never throws).
 */
export async function fetchBlueBubblesMessageAttachments(
	messageGuid: string,
	args: FetchMessageAttachmentsArgs,
): Promise<RawBlueBubblesAttachment[]> {
	const guid = (messageGuid ?? "").trim();
	if (!guid) return [];
	const url = buildBlueBubblesApiUrl({
		serverUrl: args.serverUrl,
		path: `message/${encodeURIComponent(guid)}`,
		password: args.password,
		query: { with: "attachment" },
	});
	try {
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{
				timeoutMs: args.timeoutMs ?? 10_000,
				...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
				...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
			},
		);
		if (!res.ok) return [];
		const text = await res.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
		return extractAttachmentsFromMessage(body.data);
	} catch {
		return [];
	}
}
