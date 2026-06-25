import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildDiscordV2Message,
	DISCORD_FLAG_IS_COMPONENTS_V2,
	isDiscordLinkButton,
	isDiscordV2MessageSpec,
	type DiscordBlockSpec,
} from "./component-blocks.js";

describe("buildDiscordV2Message (Fix 3c)", () => {
	it("shapes a container with text, section, separator, gallery, file, and actions blocks", () => {
		const blocks: DiscordBlockSpec[] = [
			{ type: "text", text: "Heading" },
			{ type: "section", texts: ["line one", "line two"], accessory: { kind: "thumbnail", url: "https://x/t.png" } },
			{ type: "separator", divider: true, spacing: "large" },
			{ type: "media-gallery", items: [{ url: "https://x/a.png", description: "alt" }] },
			{ type: "file", url: "attachment://doc.pdf" },
			{ type: "actions", buttons: [{ label: "Site", url: "https://x" }, { label: "Tap", customId: "g:tap" }] },
		];
		const spec = buildDiscordV2Message({ blocks, accentColor: 0x5865f2 });
		assert.ok(spec);
		assert.equal(isDiscordV2MessageSpec(spec), true);
		assert.equal(spec?.accentColor, 0x5865f2);
		assert.equal(spec?.blocks.length, 6);
		assert.equal(spec?.blocks[0]?.type, "text");
	});

	it("flag constant is the IsComponentsV2 bit (1<<15 = 32768)", () => {
		assert.equal(DISCORD_FLAG_IS_COMPONENTS_V2, 32768);
	});

	it("distinguishes a link button from an interactive button", () => {
		assert.equal(isDiscordLinkButton({ label: "L", url: "https://x" }), true);
		assert.equal(isDiscordLinkButton({ label: "B", customId: "g:b" }), false);
	});

	it("caps a section at 3 text lines + drops empty texts", () => {
		const spec = buildDiscordV2Message({
			blocks: [{ type: "section", texts: ["a", "", "b", "c", "d"] }],
		});
		const section = spec?.blocks[0];
		assert.equal(section?.type, "section");
		assert.equal(section?.type === "section" ? section.texts.length : -1, 3);
	});

	it("drops a file block whose url isn't an attachment:// ref", () => {
		const spec = buildDiscordV2Message({
			blocks: [
				{ type: "text", text: "keep" },
				{ type: "file", url: "https://x/bad.pdf" as `attachment://${string}` },
			],
		});
		assert.equal(spec?.blocks.length, 1, "the external file ref is dropped");
	});

	it("returns null when nothing renderable remains", () => {
		assert.equal(buildDiscordV2Message({ blocks: [] }), null);
		assert.equal(buildDiscordV2Message({ blocks: [{ type: "text", text: "   " }] }), null);
	});
});
