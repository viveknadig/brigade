/**
 * Worker protocol tests.
 *
 * The POSIX worker cannot be run on a Windows dev box, and the Windows worker
 * cannot be run on a Mac — so the parsing, which is where the real bugs hide, is
 * the part that has to be testable on any machine, with no interpreter and no OS
 * of its own. `SnapshotAssembler` is pure for exactly that reason.
 *
 * Two bugs already found here rather than in the field:
 *   • PowerShell's ConvertTo-Json collapses a ONE-element array to a bare scalar,
 *     so copying exactly one file produced a string where an array was expected
 *     and `files.map` threw.
 *   • Clipboard text can contain anything at all — newlines, quotes, control bytes
 *     — which is why the POSIX reply carries it base64'd instead of trying to
 *     escape it out of a shell script.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SnapshotAssembler, type WorkerEvent } from "./clipboard-worker.js";

/** Feed lines, return the events that came out. */
function run(lines: string[]): WorkerEvent[] {
	const a = new SnapshotAssembler();
	const out: WorkerEvent[] = [];
	for (const l of lines) {
		const ev = a.feed(l);
		if (ev) out.push(ev);
	}
	return out;
}

const snapOf = (evs: WorkerEvent[]) => {
	const s = evs.find((e) => e.type === "snapshot");
	assert.ok(s && s.type === "snapshot", "expected a snapshot event");
	return s;
};

describe("SnapshotAssembler — shared protocol", () => {
	it("recognises READY", () => {
		assert.deepEqual(run(["READY"]), [{ type: "ready" }]);
	});

	it("recognises the IMAGE push — the auto-attach channel", () => {
		assert.deepEqual(run(["IMAGE /tmp/shot.png"]), [{ type: "image", path: "/tmp/shot.png" }]);
	});

	it("ignores blank lines and noise", () => {
		assert.deepEqual(run(["", "   ", "IMAGE "]), []);
	});
});

describe("SnapshotAssembler — Windows (JSON)", () => {
	it("parses a full snapshot", () => {
		const ev = snapOf(
			run([
				'SNAPSHOT 3 {"imagePath":"C:\\\\tmp\\\\a.png","files":["C:\\\\x.pdf"],"text":"hi","formats":["Bitmap","Text"]}',
			]),
		);
		assert.equal(ev.id, 3);
		assert.equal(ev.snapshot.imagePath, "C:\\tmp\\a.png");
		assert.deepEqual(ev.snapshot.files, ["C:\\x.pdf"]);
		assert.equal(ev.snapshot.text, "hi");
		assert.deepEqual(ev.snapshot.formats, ["Bitmap", "Text"]);
	});

	it("normalises a ONE-element array that PowerShell collapsed to a scalar", () => {
		// ConvertTo-Json emits `"files":"C:\x.pdf"` — not an array — when exactly one
		// file is copied. Which is, of course, the most common way to copy a file.
		const ev = snapOf(run(['SNAPSHOT 1 {"files":"C:\\\\only.pdf","formats":"Bitmap"}']));
		assert.deepEqual(ev.snapshot.files, ["C:\\only.pdf"]);
		assert.deepEqual(ev.snapshot.formats, ["Bitmap"]);
	});

	it("treats a null imagePath as no image", () => {
		const ev = snapOf(run(['SNAPSHOT 2 {"imagePath":null,"files":[],"text":"","formats":[]}']));
		assert.equal(ev.snapshot.imagePath, undefined);
	});

	it("settles the request even when the JSON is garbage — a paste must never hang", () => {
		const ev = snapOf(run(["SNAPSHOT 9 {not json at all"]));
		assert.equal(ev.id, 9);
		assert.deepEqual(ev.snapshot, { files: [], text: "", formats: [] });
	});
});

describe("SnapshotAssembler — POSIX (line block)", () => {
	const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

	it("assembles a full block", () => {
		const ev = snapOf(
			run([
				"S 5 BEGIN",
				"I /tmp/shot.png",
				"F /home/me/a.pdf",
				"F /home/me/b.mp4",
				`T ${b64("hello")}`,
				"X image/png",
				"X text/plain",
				"S 5 END",
			]),
		);
		assert.equal(ev.id, 5);
		assert.equal(ev.snapshot.imagePath, "/tmp/shot.png");
		assert.deepEqual(ev.snapshot.files, ["/home/me/a.pdf", "/home/me/b.mp4"]);
		assert.equal(ev.snapshot.text, "hello");
		assert.deepEqual(ev.snapshot.formats, ["image/png", "text/plain"]);
	});

	it("carries clipboard text that would destroy any shell-escaped protocol", () => {
		// Newlines, quotes, backslashes, a pipe, and the protocol's own frame markers.
		const nasty = 'line1\nline2 "quoted" \\back| S 5 END\nIMAGE /evil.png';
		const ev = snapOf(run(["S 5 BEGIN", "I ", `T ${b64(nasty)}`, "S 5 END"]));
		assert.equal(ev.snapshot.text, nasty, "base64 is what makes this safe");
		assert.equal(ev.snapshot.imagePath, undefined);
	});

	it("emits nothing until END — a half-received block must not resolve a request", () => {
		const a = new SnapshotAssembler();
		assert.equal(a.feed("S 1 BEGIN"), null);
		assert.equal(a.feed("I /tmp/x.png"), null);
		assert.equal(a.feed("F /tmp/y.pdf"), null);
		const ev = a.feed("S 1 END");
		assert.ok(ev && ev.type === "snapshot");
	});

	it("an empty clipboard yields an empty, well-formed snapshot", () => {
		const ev = snapOf(run(["S 8 BEGIN", "I ", "T ", "S 8 END"]));
		assert.deepEqual(ev.snapshot, { files: [], text: "", formats: [] });
	});

	it("ignores an END whose id doesn't match the open block", () => {
		const a = new SnapshotAssembler();
		a.feed("S 1 BEGIN");
		assert.equal(a.feed("S 2 END"), null, "a mismatched END must not resolve anything");
	});

	it("body lines outside a block are ignored, not crashed on", () => {
		assert.deepEqual(run(["I /tmp/stray.png", "F /tmp/stray.pdf", "T aGk="]), []);
	});

	it("interleaved IMAGE pushes still work mid-block", () => {
		// The worker can push an auto-attach while a snapshot is being received.
		const evs = run(["S 4 BEGIN", "IMAGE /tmp/push.png", "I /tmp/snap.png", "T ", "S 4 END"]);
		assert.ok(evs.some((e) => e.type === "image" && e.path === "/tmp/push.png"));
		assert.equal(snapOf(evs).snapshot.imagePath, "/tmp/snap.png");
	});
});
