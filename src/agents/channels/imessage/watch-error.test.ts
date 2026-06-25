/**
 * iMessage watch-error payload sanitization (Fix 5).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { sanitizeIMessageWatchErrorPayload } from "./watch-error.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("sanitizeIMessageWatchErrorPayload", () => {
	it("returns {} for a non-object payload", () => {
		assert.deepEqual(sanitizeIMessageWatchErrorPayload(null), {});
		assert.deepEqual(sanitizeIMessageWatchErrorPayload("a string"), {});
		assert.deepEqual(sanitizeIMessageWatchErrorPayload(42), {});
		assert.deepEqual(sanitizeIMessageWatchErrorPayload(["arr"]), {});
	});

	it("keeps only a finite numeric code", () => {
		assert.deepEqual(sanitizeIMessageWatchErrorPayload({ code: 123, message: "x" }), { code: 123, message: "x" });
		// NaN / non-number code is dropped.
		const out = sanitizeIMessageWatchErrorPayload({ code: Number.NaN, message: "x" });
		assert.equal(out.code, undefined);
		const out2 = sanitizeIMessageWatchErrorPayload({ code: "500" as unknown as number, message: "x" });
		assert.equal(out2.code, undefined);
	});

	it("strips terminal control chars (ANSI escapes, raw newlines) from the message", () => {
		const evil = `line1${ESC}[31mRED${ESC}[0m\nline2\twith tab${BEL}`;
		const out = sanitizeIMessageWatchErrorPayload({ message: evil });
		assert.ok(out.message);
		// No raw ESC / BEL survive.
		assert.ok(!out.message!.includes(ESC));
		assert.ok(!out.message!.includes(BEL));
		// CR/LF/TAB are rendered as visible escapes (not raw).
		assert.ok(!out.message!.includes("\n"));
		assert.ok(out.message!.includes("\\n"));
		assert.ok(out.message!.includes("\\t"));
	});

	it("truncates a huge message to ~200 chars with an ellipsis", () => {
		const huge = "z".repeat(5_000);
		const out = sanitizeIMessageWatchErrorPayload({ message: huge });
		assert.ok(out.message);
		assert.ok(out.message!.length <= 200, `len was ${out.message!.length}`);
		assert.ok(out.message!.endsWith("…"));
	});

	it("drops a message that is empty AFTER control-char stripping (keeps the code)", () => {
		// An all-control-char message strips to "" → dropped; the code is retained.
		const allControl = `${String.fromCharCode(0)}${String.fromCharCode(7)}`;
		const out = sanitizeIMessageWatchErrorPayload({ code: 1, message: allControl });
		assert.equal(out.message, undefined);
		assert.equal(out.code, 1);
	});
});
