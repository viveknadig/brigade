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
import { scpCopyRemoteAttachment, type ScpCopyArgs } from "./remote-attachments.js";

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

/** Normalise a path's separators to `/` for cross-platform root comparison. */
function toPosixish(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * True when a resolved on-disk path lives under one of the allowed roots.
 *
 * Roots are POSIX-style macOS paths (the bridge reports paths from a Mac), so
 * matching is done on forward-slash-normalised strings — NOT `path.resolve`,
 * which on Windows would drive-root a leading-slash path and flip the separators
 * (breaking the glob-tail check). A wildcard segment in a root (e.g. the user
 * segment in /Users/<wildcard>/Library/Messages/Attachments) matches any single
 * path segment.
 */
export function isUnderAllowedRoot(filePath: string, roots: readonly string[]): boolean {
	const target = toPosixish((filePath ?? "").trim());
	if (!target) return false;
	const targetSegs = target.split("/").filter(Boolean);
	for (const root of roots) {
		const r = toPosixish(root.trim());
		if (!r) continue;
		const rootSegs = r.split("/").filter(Boolean);
		if (rootSegs.length === 0 || targetSegs.length < rootSegs.length) continue;
		let matched = true;
		for (let i = 0; i < rootSegs.length; i++) {
			if (rootSegs[i] === "*") continue;
			if (rootSegs[i] !== targetSegs[i]) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
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

/** Options for {@link resolveInboundAttachmentsRemote}. */
export interface RemoteInboundAttachmentArgs {
	/** Validated remote host (`user@host` / `host`). */
	remoteHost: string;
	/** Allowed REMOTE attachment roots the remote `original_path` must live under. */
	remoteRoots: readonly string[];
	/** TEST SEAM: the scp runner + temp-dir factory used by the copy. */
	scpRunner?: ScpCopyArgs["scpRunner"];
	mkdtempImpl?: ScpCopyArgs["mkdtempImpl"];
	/** Best-effort log for a dropped / failed remote attachment. */
	log?: (msg: string) => void;
}

/**
 * Remote-host variant of {@link resolveInboundAttachments}: the `imsg` bridge runs
 * on a DIFFERENT machine, so each attachment's `original_path` is a REMOTE path.
 * For each non-missing attachment whose remote path lives under an allowed remote
 * root, SCP-copy it to a local temp file, then build the attachment pointing at
 * the LOCAL copy (so the agent's `read` works). A copy failure drops just that
 * attachment. Returns [] when nothing resolved.
 */
export async function resolveInboundAttachmentsRemote(
	raw: RawInboundAttachment[] | null | undefined,
	args: RemoteInboundAttachmentArgs,
): Promise<InboundMediaAttachment[]> {
	if (!Array.isArray(raw)) return [];
	const out: InboundMediaAttachment[] = [];
	for (const att of raw) {
		if (!att || att.missing === true) continue;
		const remotePath = (att.original_path ?? "").trim();
		if (!remotePath) continue;
		if (args.remoteRoots.length > 0 && !isUnderAllowedRoot(remotePath, args.remoteRoots)) {
			args.log?.(`dropping inbound attachment outside allowed remote roots: ${remotePath}`);
			continue;
		}
		let localPath: string;
		try {
			localPath = await scpCopyRemoteAttachment({
				remoteHost: args.remoteHost,
				remotePath,
				...(args.scpRunner ? { scpRunner: args.scpRunner } : {}),
				...(args.mkdtempImpl ? { mkdtempImpl: args.mkdtempImpl } : {}),
			});
		} catch (err) {
			args.log?.(`failed to fetch remote attachment ${remotePath}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const mimeType = (att.mime_type ?? "").trim() || undefined;
		out.push({
			kind: mimeType ? kindFromMime(mimeType) : kindFromExt(remotePath),
			path: localPath,
			...(mimeType ? { mimeType } : {}),
			fileName: path.basename(remotePath),
		});
	}
	return out;
}
