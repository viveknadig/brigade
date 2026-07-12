/**
 * Client-side attachment plumbing for the TUI.
 *
 * Four ways a file gets attached to a turn, all converging on one
 * `StagedAttachment[]` that rides the `prompt` RPC as `PromptAttachment[]`:
 *
 *   1. `@path` — pi-tui's `CombinedAutocompleteProvider` ALREADY does fuzzy
 *      `@`-prefixed file completion (it calls the feature "file attachment
 *      completion" in its own source) and connect.ts already installs it. All
 *      that was ever missing is the SEMANTICS — reading the `@token` back out of
 *      the submitted line and treating it as a file. `extractAttachmentPaths`
 *      is that missing half.
 *   2. Drag-and-drop — every mainstream terminal (Windows Terminal, iTerm2,
 *      VS Code, GNOME Terminal) responds to a dropped file by pasting its path
 *      into stdin. We parse the shapes they paste (quoted, backslash-escaped,
 *      `file://` URI, bare) out of the submitted line.
 *   3. Clipboard image — a screenshot has NO path; it lives on the clipboard as
 *      raw bitmap data. We pull the bytes out per-OS and spool them to a temp
 *      PNG, which collapses the case back into "a path" (see `readClipboardImage`).
 *   4. `/attach <path>` — the explicit backbone.
 *
 * ── The disambiguation rule ───────────────────────────────────────────────
 * A bare path in prose ("check /etc/hosts for me") must NOT silently become an
 * attachment, and normal prose containing an `@` ("email me @ work") must not
 * either. The rule that makes this safe is: **a token is only an attachment if
 * it names a file that actually EXISTS on disk right now.** Existence is the
 * disambiguator. It costs one `statSync` per candidate token and it is what
 * lets us be aggressive about drag-drop detection without ever mangling prose.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import type { PromptAttachment } from "../protocol.js";

const execFileAsync = promisify(execFile);

/** A file staged for the next turn, plus the display facts the chip tray needs. */
export interface StagedAttachment {
	kind: PromptAttachment["kind"];
	path: string;
	mimeType: string;
	fileName: string;
	bytes: number;
	/** True when we spooled this ourselves (clipboard image) — safe to clean up. */
	ephemeral?: boolean;
}

/* ───────────────────────────── kind + mime ───────────────────────────── */

const IMAGE_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	svg: "image/svg+xml",
	heic: "image/heic",
	avif: "image/avif",
};
const VIDEO_EXT: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	m4v: "video/x-m4v",
};
const AUDIO_EXT: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
	opus: "audio/opus",
};
const DOC_EXT: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	csv: "text/csv",
	html: "text/html",
	htm: "text/html",
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
};

/**
 * Map a file to the `kind` the downstream media helpers switch on.
 *
 * `kind` is load-bearing, not cosmetic: ONLY `image` rides the turn inline as a
 * native `ImageContent` block. Everything else arrives as an `analyze_media`
 * call-to-action carrying its path, because Pi's content model is text + image
 * and there IS no other way in for a PDF or an MP4. Unknown extensions fall back
 * to `document`, which is the kind that always has a tool path available.
 */
export function inferAttachmentKind(filePath: string): PromptAttachment["kind"] {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext in IMAGE_EXT) return "image";
	if (ext in VIDEO_EXT) return "video";
	if (ext in AUDIO_EXT) return "audio";
	return "document";
}

/** Best-effort MIME from the extension. `undefined` → the gateway infers. */
export function inferMimeType(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	return (
		IMAGE_EXT[ext] ?? VIDEO_EXT[ext] ?? AUDIO_EXT[ext] ?? DOC_EXT[ext] ?? "application/octet-stream"
	);
}

/**
 * Stat a path and build the staged record. Returns null when the path isn't a
 * readable regular file — the caller reports that to the operator rather than
 * staging something that will only fail later on the gateway.
 */
export function stageAttachment(rawPath: string, opts?: { ephemeral?: boolean }): StagedAttachment | null {
	const resolved = path.resolve(expandHome(rawPath));
	let st: fs.Stats;
	try {
		st = fs.statSync(resolved);
	} catch {
		return null;
	}
	if (!st.isFile() || st.size === 0) return null;
	return {
		kind: inferAttachmentKind(resolved),
		path: resolved,
		mimeType: inferMimeType(resolved),
		fileName: path.basename(resolved),
		bytes: st.size,
		...(opts?.ephemeral ? { ephemeral: true } : {}),
	};
}

/** `~/x` → `<home>/x`. Terminals paste `~`-relative paths on macOS/Linux. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/* ─────────────────────── path extraction from a line ─────────────────── */

/**
 * The token shapes a terminal actually produces when you drop a file on it, plus
 * pi-tui's `@` completion output. Ordered longest-match-first so a quoted path
 * wins over the bare prefix inside it.
 *
 *   @"C:\a b\x.png"   @-prefixed, quoted (pi-tui, path with spaces)
 *   "C:\a b\x.png"    quoted (Windows Terminal drag-drop, spaces)
 *   'C:\a b\x.png'    single-quoted (some shells)
 *   file:///a/x.png   URI (GNOME/Wayland drag-drop)
 *   /Users/a/my\ x.png  backslash-escaped spaces (macOS/iTerm drag-drop)
 *   @src/foo.ts       @-prefixed bare (pi-tui completion)
 *   C:\a\x.png        bare absolute
 */
// Two subtleties, both learned the hard way on Windows:
//
//   1. The escaped-space branch `\\ ` MUST come first in each alternation. Try
//      `[^\s"']` first and it happily eats the lone backslash of `my\ report.pdf`,
//      then chokes on the space — truncating the path to `…/my\`.
//   2. The `@bare` branch has to ALLOW backslashes, or `@C:\shots\bug.png` never
//      matches as an `@`-token; the bare-absolute branch below then swallows the
//      path on its own and leaves an orphaned `@` in the text.
const TOKEN_PATTERNS: RegExp[] = [
	/@"([^"]+)"/g, // @-quoted
	/@'([^']+)'/g,
	/"([^"]+)"/g, // quoted
	/'([^']+)'/g,
	/\bfile:\/\/(\/[^\s"']+)/g, // file:// URI
	/@((?:\\ |[^\s@"'])+)/g, // @bare — backslash-aware, escaped-space-first
	/((?:[A-Za-z]:[\\/]|\/|~[\\/])(?:\\ |[^\s"'])+)/g, // bare absolute / ~-relative
];

export interface ExtractedAttachments {
	/** The line with each matched path token replaced by the file's basename. */
	text: string;
	/** Files that exist on disk, in the order they appeared. Deduped by path. */
	staged: StagedAttachment[];
}

/**
 * Pull attachment paths out of a submitted line.
 *
 * Each matched token is replaced in the text by the file's BASENAME rather than
 * being deleted. That keeps the sentence readable — "look at @C:\shots\bug.png
 * and tell me" becomes "look at bug.png and tell me" — while the full path still
 * reaches the model, because the gateway prepends an `[attached image → <path>]`
 * note built from the attachment list. Deleting the token instead would leave
 * "look at  and tell me", stranding the referent.
 *
 * A token that does NOT resolve to a real file is left completely untouched, so
 * ordinary prose (`email me @ work`, `check /etc/hosts`) is never rewritten.
 */
export function extractAttachmentPaths(line: string): ExtractedAttachments {
	const staged: StagedAttachment[] = [];
	const seen = new Set<string>();
	let text = line;

	for (const pattern of TOKEN_PATTERNS) {
		// Fresh regex per pass — these are module-level /g literals and carry
		// `lastIndex` state across calls otherwise.
		const re = new RegExp(pattern.source, pattern.flags);
		text = text.replace(re, (whole, captured: string) => {
			const candidate = decodeCandidate(captured);
			const att = stageAttachment(candidate);
			// Not a real file → leave the ORIGINAL token exactly as the user typed it.
			if (!att) return whole;
			if (seen.has(att.path)) return att.fileName;
			seen.add(att.path);
			staged.push(att);
			return att.fileName;
		});
	}

	return { text: text.replace(/[ \t]{2,}/g, " ").trim(), staged };
}

/** Undo the escaping a terminal applies when it pastes a dropped path. */
function decodeCandidate(raw: string): string {
	let s = raw.trim();
	s = s.replace(/\\ /g, " "); // macOS/iTerm escape spaces
	if (s.startsWith("file://")) s = s.slice("file://".length);
	// A file:// URI is percent-encoded; a plain Windows path is not, and decoding
	// one is harmless (no % in a normal path). Guard anyway — a malformed escape
	// sequence would otherwise throw and kill the submit.
	try {
		if (/%[0-9A-Fa-f]{2}/.test(s)) s = decodeURIComponent(s);
	} catch {
		/* leave as-is */
	}
	// `/C:/x` — what a Windows file:// URI decodes to.
	if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
	return s;
}

/* ──────────────────────────── clipboard ──────────────────────────────── */

/** Where we spool clipboard bitmaps. OS temp — never `~/.brigade` (strict-zero). */
function spoolDir(): string {
	const dir = path.join(os.tmpdir(), "brigade-attachments");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function spoolPath(ext: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(spoolDir(), `clipboard-${stamp}.${ext}`);
}

/**
 * Read an image off the OS clipboard and spool it to a temp PNG.
 *
 * This is the screenshot→paste path, and it is the one piece of this feature
 * that CANNOT go through the terminal: a terminal forwards keystrokes and text,
 * never binary clipboard data. So we ask the OS directly.
 *
 * Returns null when the clipboard holds no image (the common case — it usually
 * holds text), which the caller reports as "no image on the clipboard" rather
 * than treating as an error.
 *
 * Windows note: clipboard access needs an STA thread, and PowerShell 7 (`pwsh`)
 * runs MTA by default — `[Windows.Forms.Clipboard]::GetImage()` returns null
 * there for reasons that have nothing to do with the clipboard's contents. We
 * deliberately shell out to `powershell.exe` (Windows PowerShell 5.1, present on
 * every Win10/11 box) with an explicit `-STA`, which is the only reliably
 * working combination.
 */
export async function readClipboardImage(): Promise<StagedAttachment | null> {
	const out = spoolPath("png");
	try {
		if (process.platform === "win32") {
			const ps = [
				"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
				"$img = [Windows.Forms.Clipboard]::GetImage();",
				`if ($img -ne $null) { $img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }`,
				"else { Write-Output 'none' }",
			].join(" ");
			const { stdout } = await execFileAsync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
				{ timeout: 10_000 },
			);
			if (!stdout.includes("ok")) return null;
		} else if (process.platform === "darwin") {
			// «class PNGf» is the clipboard's PNG flavour. `try` makes a text-only
			// clipboard return "none" instead of raising.
			const script = [
				"try",
				"  set png to (the clipboard as «class PNGf»)",
				`  set fp to (open for access POSIX file "${out}" with write permission)`,
				"  write png to fp",
				"  close access fp",
				'  return "ok"',
				"on error",
				'  return "none"',
				"end try",
			].join("\n");
			const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
			if (!stdout.includes("ok")) return null;
		} else {
			// Wayland first, then X11. Both write raw PNG bytes to stdout.
			const tools: Array<[string, string[]]> = [
				["wl-paste", ["--no-newline", "--type", "image/png"]],
				["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
			];
			let wrote = false;
			for (const [bin, args] of tools) {
				try {
					const { stdout } = await execFileAsync(bin, args, {
						timeout: 10_000,
						encoding: "buffer",
						maxBuffer: 64 * 1024 * 1024,
					});
					const buf = stdout as unknown as Buffer;
					if (buf?.length > 0) {
						fs.writeFileSync(out, buf);
						wrote = true;
						break;
					}
				} catch {
					continue; // tool absent or clipboard has no image — try the next
				}
			}
			if (!wrote) return null;
		}
	} catch {
		return null; // no clipboard tooling, or the OS refused — not an error worth throwing
	}
	return stageAttachment(out, { ephemeral: true });
}

/**
 * Read a FILE LIST off the clipboard — the other clipboard mechanism.
 *
 * Copying a file in Explorer/Finder does NOT put its bytes on the clipboard; it
 * puts a reference. That's why copy-pasting a 400 MB video works: we only ever
 * move the path, and read the bytes off disk. Complements `readClipboardImage`,
 * which handles the no-file-exists case (a screenshot).
 */
export async function readClipboardFiles(): Promise<StagedAttachment[]> {
	try {
		if (process.platform === "win32") {
			const ps = [
				"Add-Type -AssemblyName System.Windows.Forms;",
				"$f = [Windows.Forms.Clipboard]::GetFileDropList();",
				"if ($f -ne $null) { $f | ForEach-Object { Write-Output $_ } }",
			].join(" ");
			const { stdout } = await execFileAsync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
				{ timeout: 10_000 },
			);
			return stageAll(stdout.split(/\r?\n/));
		}
		if (process.platform === "darwin") {
			const script = [
				"try",
				'  return POSIX path of (the clipboard as «class furl»)',
				"on error",
				'  return ""',
				"end try",
			].join("\n");
			const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
			return stageAll(stdout.split(/\r?\n/));
		}
		for (const [bin, args] of [
			["wl-paste", ["--no-newline", "--type", "text/uri-list"]],
			["xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]],
		] as Array<[string, string[]]>) {
			try {
				const { stdout } = await execFileAsync(bin, args, { timeout: 10_000 });
				const staged = stageAll(stdout.split(/\r?\n/).map((l) => decodeCandidate(l)));
				if (staged.length > 0) return staged;
			} catch {
				continue;
			}
		}
	} catch {
		/* fall through */
	}
	return [];
}

function stageAll(lines: string[]): StagedAttachment[] {
	const out: StagedAttachment[] = [];
	const seen = new Set<string>();
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const att = stageAttachment(decodeCandidate(line));
		if (att && !seen.has(att.path)) {
			seen.add(att.path);
			out.push(att);
		}
	}
	return out;
}

/* ─────────────────────────────── display ─────────────────────────────── */

const KIND_ICON: Record<PromptAttachment["kind"], string> = {
	image: "🖼",
	video: "🎬",
	audio: "🎵",
	voice: "🎙",
	document: "📄",
	sticker: "🏷",
};

export function attachmentIcon(kind: PromptAttachment["kind"]): string {
	return KIND_ICON[kind] ?? "📎";
}

/** `1.2 MB` — operator-facing sizes in the chip tray. */
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

/** The wire shape — drops the client-only display fields. */
export function toPromptAttachments(staged: readonly StagedAttachment[]): PromptAttachment[] {
	return staged.map((s) => ({
		kind: s.kind,
		path: s.path,
		mimeType: s.mimeType,
		fileName: s.fileName,
	}));
}
