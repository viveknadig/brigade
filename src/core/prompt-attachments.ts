/**
 * Gateway-side resolution of the files a client attached to a `prompt` turn.
 *
 * The TUI sends PATHS, not bytes (see `PromptAttachment` in `protocol.ts`).
 * This module turns that wire list into the `InboundMediaAttachment[]` the
 * channel inbound pipeline already speaks, so the turn can then run through the
 * SAME `buildMediaNote` + `buildInboundImageBlocks` pair a WhatsApp photo runs
 * through. Everything downstream — inline vision blocks on a vision-capable
 * model, STT transcription of a voice note, the `analyze_media` call-to-action
 * for a PDF — is inherited, not reimplemented.
 *
 * ── On trust ──────────────────────────────────────────────────────────────
 * The paths arrive over the wire, and we read bytes off them. That is NOT a new
 * privilege: `prompt` is already an operator-privileged RPC (it runs a turn as
 * the agent, and the agent holds `read`/`bash`), and it passes the same
 * `sessionsAccessCheck` gate as `sessions.send`. A caller who can invoke
 * `prompt` can already ask the agent to read any file it likes, in English.
 *
 * So the checks below are NOT an authorization boundary — they are a
 * FOOTGUN boundary. They exist to make a malformed or hostile attachment list
 * fail loudly and cheaply instead of wedging a turn: no directories (a stray
 * `@src/` completion), no device/FIFO files (a read that never returns), no
 * unbounded reads, no silent drops. Rejections are returned to the caller and
 * surfaced in the TUI rather than swallowed, because an attachment that
 * vanished without explanation is worse than one that failed out loud.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { InboundMediaAttachment } from "../agents/extensions/types.js";
import type { PromptAttachment } from "../protocol.js";

/**
 * Max files on a single turn. Matches `INBOUND_IMAGE_DEBOUNCE_MAX` (8) in the
 * channel pipeline — the ceiling exists for the same reason (a turn payload has
 * to stay bounded), so the two surfaces agree on the number.
 */
export const PROMPT_ATTACHMENT_MAX_COUNT = 8;

/**
 * Per-file byte ceiling. Deliberately MUCH larger than the 8 MiB inline-image
 * cap in `media-capture.ts`, because a non-image attachment never rides the
 * turn as bytes — only its PATH does, and `analyze_media` does its own bounded
 * read. So this cap is not about context cost; it is a sanity bound that keeps
 * an operator from stat-ing a 40 GB disk image and wondering why nothing
 * happened. An oversized IMAGE is still accepted here and simply not inlined
 * downstream (media-capture drops it and the path note carries it to the tool).
 */
export const PROMPT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;

/** An attachment we refused, and why — surfaced to the operator verbatim. */
export interface RejectedAttachment {
	path: string;
	reason: string;
}

export interface ResolvedPromptAttachments {
	/** Accepted files, in the shape the channel media helpers consume. */
	media: InboundMediaAttachment[];
	/** Refused files + human-readable reasons. Never silently dropped. */
	rejected: RejectedAttachment[];
}

/**
 * Validate + normalize the wire attachments for one turn.
 *
 * Never throws: a bad attachment is a `rejected` entry, not a failed turn. The
 * operator's TEXT still deserves to reach the model even if the file they
 * dragged in was a directory.
 */
export async function resolvePromptAttachments(
	raw: ReadonlyArray<PromptAttachment> | undefined,
): Promise<ResolvedPromptAttachments> {
	const media: InboundMediaAttachment[] = [];
	const rejected: RejectedAttachment[] = [];
	if (!raw || raw.length === 0) return { media, rejected };

	for (const a of raw) {
		const p = typeof a?.path === "string" ? a.path.trim() : "";
		if (!p) {
			rejected.push({ path: String(a?.path ?? ""), reason: "empty path" });
			continue;
		}

		if (media.length >= PROMPT_ATTACHMENT_MAX_COUNT) {
			rejected.push({
				path: p,
				reason: `over the ${PROMPT_ATTACHMENT_MAX_COUNT}-attachment limit for one turn`,
			});
			continue;
		}

		// Absolute only. A relative path would resolve against the GATEWAY's cwd,
		// which is not the client's cwd — it would silently read the wrong file (or
		// nothing) on a remote gateway. Better to refuse than to guess.
		if (!path.isAbsolute(p)) {
			rejected.push({ path: p, reason: "path must be absolute" });
			continue;
		}

		// `stat`, not `lstat`: a symlink to a real file is a legitimate attachment
		// (macOS aliases, linked media libraries). We care what it POINTS AT, and
		// the `isFile()` check below is what actually protects us.
		let st: Awaited<ReturnType<typeof fsp.stat>>;
		try {
			st = await fsp.stat(p);
		} catch {
			rejected.push({ path: p, reason: "not found or unreadable" });
			continue;
		}

		// Directories and device/FIFO/socket files. A FIFO is the dangerous one: a
		// read on it can block forever and wedge the turn behind it.
		if (st.isDirectory()) {
			rejected.push({ path: p, reason: "is a directory, not a file" });
			continue;
		}
		if (!st.isFile()) {
			rejected.push({ path: p, reason: "not a regular file" });
			continue;
		}
		if (st.size === 0) {
			rejected.push({ path: p, reason: "file is empty" });
			continue;
		}
		if (st.size > PROMPT_ATTACHMENT_MAX_BYTES) {
			rejected.push({
				path: p,
				reason: `file is ${formatBytes(st.size)} — over the ${formatBytes(PROMPT_ATTACHMENT_MAX_BYTES)} limit`,
			});
			continue;
		}

		media.push({
			kind: a.kind,
			path: p,
			...(a.mimeType ? { mimeType: a.mimeType } : {}),
			fileName: a.fileName?.trim() || path.basename(p),
		});
	}

	return { media, rejected };
}

/** `1.2 MB` — for operator-facing reject reasons, not for logs. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
