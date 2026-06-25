/**
 * iMessage media helpers — outbound attachment resolution + inbound kind
 * inference.
 *
 * OUTBOUND: the `imsg` bridge sends an attachment by LOCAL PATH (the `file` RPC
 * param), so there is no upload step — we just validate the local path through
 * Brigade's outbound media-path guard (so a prompt-injected "send ~/.ssh/id_rsa"
 * can't exfiltrate a secret) and enforce the per-account size cap. The resolved
 * `{ path, kind, mimeType }` is what `send.ts` hands the RPC.
 *
 * INBOUND: the bridge has ALREADY saved received attachments to disk under the
 * macOS Messages Attachments dir (the `attachmentRoots` allow-list). We don't
 * fetch anything — we just map the bridge's reported `mime_type` to a Brigade
 * media `kind` and surface the on-disk `path` so the agent can `read` it. The
 * path is checked against the configured attachment roots so a malicious bridge
 * payload can't point Brigade at an arbitrary file.
 */

import { statSync } from "node:fs";
import path from "node:path";

// Channel SDK barrel — the outbound-media exfil guard + the contract types. All
// contract types come from the channel SDK barrel so the channel is built
// entirely on `../sdk.js`.
import { validateOutboundMediaPath, type InboundMediaAttachment, type OutboundMedia } from "../sdk.js";

/** Brigade media kinds an attachment can be. */
type MediaKind = OutboundMedia["kind"];

/** Map a MIME type to a Brigade media kind (defaults to `document`). */
export function kindFromMime(mime?: string): MediaKind {
	const m = (mime ?? "").trim().toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	return "document";
}

/** Map a file extension to a Brigade media kind (defaults to `document`). */
export function kindFromExt(filePath: string): MediaKind {
	const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
	if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"].includes(ext)) return "image";
	if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) return "video";
	if (["mp3", "m4a", "aac", "wav", "ogg", "flac", "caf", "amr"].includes(ext)) return "audio";
	return "document";
}

/** Result of resolving an outbound attachment for the send path. */
export interface ResolvedOutboundAttachment {
	/** Absolute local path the RPC's `file` param points at. */
	path: string;
	/** Inferred media kind (for the `<media:kind>` placeholder when text is empty). */
	kind: MediaKind;
	/** Inferred MIME type, when known. */
	mimeType?: string;
}

/**
 * Resolve an outbound media path for the send RPC: run the exfil guard, enforce
 * the size cap, and infer the kind. Throws an operator-facing error when the
 * path is refused or too large.
 */
export function resolveOutboundAttachment(rawPath: string, maxBytes: number): ResolvedOutboundAttachment {
	const filePath = (rawPath ?? "").trim();
	if (!filePath) throw new Error("iMessage media path is required");
	const verdict = validateOutboundMediaPath(filePath);
	if (!verdict.ok) {
		throw new Error(`iMessage refused to attach "${filePath}": ${verdict.reason}`);
	}
	const resolved = path.resolve(filePath);
	let size = 0;
	try {
		size = statSync(resolved).size;
	} catch {
		throw new Error(`iMessage media path not found: ${resolved}`);
	}
	if (maxBytes > 0 && size > maxBytes) {
		const mb = (maxBytes / (1024 * 1024)).toFixed(0);
		throw new Error(`iMessage media is too large (${(size / (1024 * 1024)).toFixed(1)} MB > ${mb} MB cap)`);
	}
	return { path: resolved, kind: kindFromExt(resolved) };
}

/**
 * Build an OutboundMedia descriptor's `kind` for a path (used when the caller
 * already validated the path). Mirrors `kindFromExt` but kept as a named export
 * so callers read clearly.
 */
export function inferOutboundMediaKind(media: OutboundMedia): MediaKind {
	if (media.kind) return media.kind;
	return kindFromExt(media.path);
}

/** True when a resolved on-disk path lives under one of the allowed roots. */
export function isUnderAllowedRoot(filePath: string, roots: readonly string[]): boolean {
	const target = path.resolve(filePath);
	for (const root of roots) {
		const r = root.trim();
		if (!r) continue;
		// A glob root (`/Users/*/Library/...`) matches by its non-glob prefix.
		const globIdx = r.indexOf("*");
		if (globIdx >= 0) {
			const prefix = path.resolve(r.slice(0, globIdx).replace(/[\\/]+$/, ""));
			// Match the segment before the glob, then require the Attachments tail.
			const tail = r.slice(globIdx + 1).replace(/^[\\/]+/, "");
			if (target.startsWith(prefix) && (!tail || target.includes(tail.split("*")[0] ?? tail))) return true;
			continue;
		}
		const resolvedRoot = path.resolve(r);
		if (target === resolvedRoot || target.startsWith(resolvedRoot + path.sep)) return true;
	}
	return false;
}

/** One raw inbound attachment as reported by the `imsg` bridge. */
export interface RawInboundAttachment {
	original_path?: string | null;
	mime_type?: string | null;
	missing?: boolean | null;
}

/**
 * Map the bridge's reported inbound attachments to Brigade `InboundMediaAttachment`s,
 * dropping any that are missing or whose on-disk path falls outside the allowed
 * roots. Returns [] when nothing resolved.
 */
export function resolveInboundAttachments(
	raw: RawInboundAttachment[] | null | undefined,
	allowedRoots: readonly string[],
): InboundMediaAttachment[] {
	if (!Array.isArray(raw)) return [];
	const out: InboundMediaAttachment[] = [];
	for (const att of raw) {
		if (!att || att.missing === true) continue;
		const p = (att.original_path ?? "").trim();
		if (!p) continue;
		if (allowedRoots.length > 0 && !isUnderAllowedRoot(p, allowedRoots)) continue;
		const mimeType = (att.mime_type ?? "").trim() || undefined;
		out.push({
			kind: mimeType ? kindFromMime(mimeType) : kindFromExt(p),
			path: p,
			...(mimeType ? { mimeType } : {}),
			fileName: path.basename(p),
		});
	}
	return out;
}
