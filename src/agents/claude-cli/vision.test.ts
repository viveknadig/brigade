/**
 * The claude-cli backend used to declare `input: ["text"]` and flatten every
 * attached image to the literal string "[image omitted]". That made the
 * declaration internally honest but the CAPABILITY wrong — the binary was never
 * the limitation. And because the agent loop gates inline images on exactly that
 * field (`resolveInboundImagePrompt`), an operator on a subscription login had
 * their screenshot silently dropped while the TUI cheerfully told them that
 * Claude Opus "can't see images".
 *
 * Verified live against `claude` 2.1.177 before writing any of this: given an
 * image block on `--input-format stream-json` stdin, Opus 4.8 returns a detailed
 * description of the picture.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildClaudeCliArgs } from "./catalog.js";
import { synthClaudeCliModel } from "./register.js";
import { collectPromptImages, serializeStreamJsonPrompt } from "./stream.js";

const IMG = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

describe("claude-cli — vision capability", () => {
	it("declares image input, so the agent loop stops dropping the operator's screenshot", () => {
		const input = synthClaudeCliModel("claude-opus-4-8").input as string[];
		assert.ok(input.includes("image"), "Opus can see; the backend must say so");
		assert.ok(input.includes("text"));
	});

	it("declares it for an UNKNOWN (newer) model id too — every Claude model has vision", () => {
		const input = synthClaudeCliModel("claude-opus-5-9").input as string[];
		assert.ok(input.includes("image"));
	});
});

describe("claude-cli — collectPromptImages", () => {
	it("finds image blocks on the current user message", () => {
		const imgs = collectPromptImages([
			{ role: "user", content: [{ type: "text", text: "look" }, IMG] },
		]);
		assert.equal(imgs.length, 1);
		assert.equal(imgs[0]?.source.media_type, "image/png");
		assert.equal(imgs[0]?.source.data, "aGVsbG8=");
		assert.equal(imgs[0]?.source.type, "base64");
	});

	it("reads only the LAST user message — history must not re-send the whole album", () => {
		// This backend replays prior turns as flattened `Human:`/`Assistant:` text. If
		// we swept every historical image back in on each turn, saying "and?" would
		// re-transmit and re-bill every picture ever attached to the thread.
		const imgs = collectPromptImages([
			{ role: "user", content: [IMG] },
			{ role: "assistant", content: "a cell" },
			{ role: "user", content: [{ type: "text", text: "and?" }] },
		]);
		assert.equal(imgs.length, 0);
	});

	it("returns nothing for a plain text turn", () => {
		assert.deepEqual(collectPromptImages([{ role: "user", content: "hi" }]), []);
	});

	it("defaults a missing mime to image/png rather than dropping the block", () => {
		const imgs = collectPromptImages([
			{ role: "user", content: [{ type: "image", data: "eA==" }] },
		]);
		assert.equal(imgs[0]?.source.media_type, "image/png");
	});
});

describe("claude-cli — stdin protocol", () => {
	it("a TEXT turn keeps plain-text stdin — no --input-format flag at all", () => {
		// The whole point of gating on images: every existing turn in the product must
		// take the byte-identical path it always has.
		const args = buildClaudeCliArgs({ modelId: "claude-opus-4-8" });
		assert.ok(!args.includes("--input-format"), "text turns must not change protocol");
	});

	it("an IMAGE turn switches stdin to stream-json", () => {
		const args = buildClaudeCliArgs({ modelId: "claude-opus-4-8", streamJsonInput: true });
		const i = args.indexOf("--input-format");
		assert.ok(i >= 0, "an image turn needs a content-block protocol");
		assert.equal(args[i + 1], "stream-json");
	});

	it("serializes one Anthropic user message carrying text + the image blocks", () => {
		const line = serializeStreamJsonPrompt("what is this?", [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
		]);
		assert.ok(line.endsWith("\n"), "the CLI reads stdin line-delimited");
		const parsed = JSON.parse(line) as {
			type: string;
			message: { role: string; content: Array<Record<string, unknown>> };
		};
		assert.equal(parsed.type, "user");
		assert.equal(parsed.message.role, "user");
		assert.equal(parsed.message.content[0]?.type, "text");
		assert.equal(parsed.message.content[0]?.text, "what is this?");
		assert.equal(parsed.message.content[1]?.type, "image");
		assert.deepEqual(parsed.message.content[1]?.source, {
			type: "base64",
			media_type: "image/png",
			data: "aGk=",
		});
	});

	it("omits an empty text block — a wordless image drop is still a valid turn", () => {
		const line = serializeStreamJsonPrompt("", [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
		]);
		const parsed = JSON.parse(line) as { message: { content: Array<{ type: string }> } };
		assert.equal(parsed.message.content.length, 1);
		assert.equal(parsed.message.content[0]?.type, "image");
	});
});
