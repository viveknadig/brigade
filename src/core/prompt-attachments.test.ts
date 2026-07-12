/**
 * These checks are a FOOTGUN boundary, not an authorization boundary (see the
 * module header): `prompt` is already operator-privileged. What they buy is that
 * a malformed attachment list fails loudly and cheaply instead of wedging a turn
 * — and, critically, that a rejected file is REPORTED rather than silently
 * dropped, because an attachment that vanished without explanation is the worst
 * possible outcome for the operator.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { PROMPT_ATTACHMENT_MAX_COUNT, resolvePromptAttachments } from "./prompt-attachments.js";
import type { PromptAttachment } from "../protocol.js";

let dir: string;
let png: string;

before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-pa-test-"));
	png = path.join(dir, "shot.png");
	fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const att = (over: Partial<PromptAttachment>): PromptAttachment => ({
	kind: "image",
	path: png,
	mimeType: "image/png",
	fileName: "shot.png",
	...over,
});

describe("resolvePromptAttachments", () => {
	it("is a no-op for the historical caller — undefined attachments", async () => {
		const r = await resolvePromptAttachments(undefined);
		assert.deepEqual(r.media, []);
		assert.deepEqual(r.rejected, []);
	});

	it("resolves a real file into the channel media shape", async () => {
		const r = await resolvePromptAttachments([att({})]);
		assert.deepEqual(r.rejected, []);
		assert.equal(r.media.length, 1);
		assert.equal(r.media[0]?.kind, "image");
		assert.equal(r.media[0]?.path, png);
		assert.equal(r.media[0]?.mimeType, "image/png");
		assert.equal(r.media[0]?.fileName, "shot.png");
	});

	it("backfills fileName from the path when the client omits it", async () => {
		const r = await resolvePromptAttachments([att({ fileName: undefined })]);
		assert.equal(r.media[0]?.fileName, "shot.png");
	});

	it("refuses a relative path — it would resolve against the GATEWAY's cwd, not the client's", async () => {
		const r = await resolvePromptAttachments([att({ path: "shot.png" })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /absolute/);
	});

	it("refuses a directory — a stray `@src/` completion must not wedge the turn", async () => {
		const r = await resolvePromptAttachments([att({ path: dir })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /directory/);
	});

	it("refuses a missing file, and says so", async () => {
		const gone = path.join(dir, "gone.png");
		const r = await resolvePromptAttachments([att({ path: gone })]);
		assert.equal(r.media.length, 0);
		assert.equal(r.rejected[0]?.path, gone);
		assert.match(r.rejected[0]?.reason ?? "", /not found/);
	});

	it("refuses an empty file", async () => {
		const empty = path.join(dir, "empty.png");
		fs.writeFileSync(empty, "");
		const r = await resolvePromptAttachments([att({ path: empty })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /empty/);
	});

	it("caps the count, and reports the overflow instead of dropping it silently", async () => {
		const many = Array.from({ length: PROMPT_ATTACHMENT_MAX_COUNT + 3 }, () => att({}));
		const r = await resolvePromptAttachments(many);
		assert.equal(r.media.length, PROMPT_ATTACHMENT_MAX_COUNT);
		assert.equal(r.rejected.length, 3);
		assert.match(r.rejected[0]?.reason ?? "", /limit/);
	});

	it("keeps the good files when one in the batch is bad — a bad drop must not kill the turn", async () => {
		const r = await resolvePromptAttachments([
			att({ path: path.join(dir, "ghost.png") }),
			att({}),
		]);
		assert.equal(r.media.length, 1);
		assert.equal(r.media[0]?.path, png);
		assert.equal(r.rejected.length, 1);
	});
});
