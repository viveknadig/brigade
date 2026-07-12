/**
 * The load-bearing property here is the DISAMBIGUATION RULE: a token becomes an
 * attachment only if it names a file that exists on disk. Everything else about
 * drag-drop parsing is forgiving, but this rule is what stops us rewriting an
 * operator's ordinary prose ("email me @ work", "check /etc/hosts") into
 * something they didn't type. Most of these tests exist to hold that line.
 *
 * The two escaped-path cases are not hypothetical: both regexes below shipped
 * broken on Windows the first time and these caught it.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	extractAttachmentPaths,
	inferAttachmentKind,
	inferMimeType,
	stageAttachment,
} from "./attachments.js";

let dir: string;
let png: string;
let pdf: string;
let spaced: string;

before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-att-test-"));
	png = path.join(dir, "shot.png");
	pdf = path.join(dir, "spec.pdf");
	spaced = path.join(dir, "my report.pdf");
	fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
	fs.writeFileSync(pdf, "%PDF-1.4 hello");
	fs.writeFileSync(spaced, "%PDF-1.4 spaced");
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("inferAttachmentKind", () => {
	it("routes images to the one kind that rides the turn inline", () => {
		assert.equal(inferAttachmentKind("/a/b.png"), "image");
		assert.equal(inferAttachmentKind("/a/b.JPEG"), "image");
		assert.equal(inferAttachmentKind("/a/b.webp"), "image");
	});

	it("classifies video and audio", () => {
		assert.equal(inferAttachmentKind("/a/b.mp4"), "video");
		assert.equal(inferAttachmentKind("/a/b.mov"), "video");
		assert.equal(inferAttachmentKind("/a/b.mp3"), "audio");
		assert.equal(inferAttachmentKind("/a/b.wav"), "audio");
	});

	it("falls back to document for anything unknown — the kind that always has a tool path in", () => {
		assert.equal(inferAttachmentKind("/a/b.pdf"), "document");
		assert.equal(inferAttachmentKind("/a/b.xyz"), "document");
		assert.equal(inferAttachmentKind("/a/README"), "document");
	});
});

describe("inferMimeType", () => {
	it("maps known extensions", () => {
		assert.equal(inferMimeType("/a/b.png"), "image/png");
		assert.equal(inferMimeType("/a/b.jpg"), "image/jpeg");
		assert.equal(inferMimeType("/a/b.pdf"), "application/pdf");
	});

	it("degrades to octet-stream rather than guessing", () => {
		assert.equal(inferMimeType("/a/b.zzz"), "application/octet-stream");
	});
});

describe("stageAttachment", () => {
	it("stages a real file with its size and kind", () => {
		const a = stageAttachment(png);
		assert.ok(a);
		assert.equal(a.kind, "image");
		assert.equal(a.fileName, "shot.png");
		assert.equal(a.mimeType, "image/png");
		assert.equal(a.bytes, 7);
	});

	it("refuses a directory", () => {
		assert.equal(stageAttachment(dir), null);
	});

	it("refuses a path that does not exist", () => {
		assert.equal(stageAttachment(path.join(dir, "nope.png")), null);
	});

	it("refuses an empty file — nothing to look at", () => {
		const empty = path.join(dir, "empty.png");
		fs.writeFileSync(empty, "");
		assert.equal(stageAttachment(empty), null);
	});
});

describe("extractAttachmentPaths — the disambiguation rule", () => {
	it("leaves prose with a bare @ completely untouched", () => {
		const r = extractAttachmentPaths("email me @ work about it");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "email me @ work about it");
	});

	it("does NOT attach a path in prose that isn't a real file", () => {
		const r = extractAttachmentPaths("check /etc/hosts and /var/log/nope.log for me");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "check /etc/hosts and /var/log/nope.log for me");
	});

	it("leaves a non-existent @token exactly as typed", () => {
		const r = extractAttachmentPaths("look at @src/ghost.ts please");
		assert.equal(r.staged.length, 0);
		assert.equal(r.text, "look at @src/ghost.ts please");
	});

	it("captures an @token that IS a real file, replacing it with the basename", () => {
		const r = extractAttachmentPaths(`look at @${png} and tell me`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, png);
		assert.equal(r.staged[0]?.kind, "image");
		// Basename, not deletion — deleting would strand the referent ("look at  and tell me").
		assert.equal(r.text, "look at shot.png and tell me");
	});

	it("captures a bare dropped absolute path", () => {
		const r = extractAttachmentPaths(`${pdf} summarize this`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, pdf);
		assert.equal(r.text, "spec.pdf summarize this");
	});

	it("captures a quoted path with spaces — what a terminal pastes on drag-drop", () => {
		const r = extractAttachmentPaths(`"${spaced}" what's in it`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, spaced);
		assert.equal(r.staged[0]?.fileName, "my report.pdf");
	});

	it("captures a backslash-escaped path — what macOS/iTerm pastes on drag-drop", () => {
		// Regression: the alternation used to try `[^\s"']` first, which ate the lone
		// backslash and truncated the path at `…/my\`.
		const escaped = spaced.replace(/ /g, "\\ ");
		const r = extractAttachmentPaths(`${escaped} read it`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, spaced);
	});

	it("captures a file:// URI — what GNOME/Wayland pastes on drag-drop", () => {
		// Windows absolute paths become file:///C:/… — the leading slash is stripped.
		const uri =
			process.platform === "win32" ? `file:///${png.replace(/\\/g, "/")}` : `file://${png}`;
		const r = extractAttachmentPaths(`${uri} describe`);
		assert.equal(r.staged.length, 1);
		assert.equal(r.staged[0]?.path, png);
	});

	it("captures several files at once and dedupes a repeat", () => {
		const r = extractAttachmentPaths(`@${png} and @${pdf} and @${png} again`);
		assert.equal(r.staged.length, 2);
		assert.deepEqual(
			r.staged.map((s) => s.path).sort(),
			[png, pdf].sort(),
		);
	});

	it("handles a pure drop with no words — a valid turn on its own", () => {
		const r = extractAttachmentPaths(png);
		assert.equal(r.staged.length, 1);
		assert.equal(r.text, "shot.png");
	});
});
