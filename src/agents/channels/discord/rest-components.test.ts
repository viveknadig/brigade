/**
 * Discord REST-JSON component serializers (Fix A1) — unit tests.
 *
 * Asserts the spec→REST-JSON path produces the on-the-wire Discord component
 * shapes AND carries the custom_id codecs the press-routing already understands:
 *   - a select row's custom_id is general-prefixed (a press decodes to the token);
 *   - a modal trigger registers an entry + emits a `modal:<id>` marker button;
 *   - a V2 blocks spec produces a container + the IsComponentsV2 flag, with text
 *     moved into TextDisplay blocks.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decodeGeneralCallbackData, isGeneralCallbackData } from "../general-callback.js";
import { DISCORD_FLAG_IS_COMPONENTS_V2 } from "./component-blocks.js";
import { __resetDiscordModalRegistryForTest, getDiscordModal } from "./modal-registry.js";
import { decodeDiscordModalCustomId, isDiscordModalCustomId } from "./modals.js";
import {
	DISCORD_COMPONENT_TYPE,
	serializeDiscordModalTrigger,
	serializeDiscordSelectRow,
	serializeDiscordV2Message,
} from "./rest-components.js";

describe("serializeDiscordSelectRow", () => {
	it("builds a string-select action row whose custom_id is general-prefixed + decodes to the token", () => {
		const res = serializeDiscordSelectRow({
			kind: "string",
			customId: "pick_color",
			placeholder: "choose",
			options: [
				{ label: "Red", value: "r" },
				{ label: "Blue", value: "b", description: "the cool one" },
			],
		});
		assert.ok(res.ok, "serialized");
		if (!res.ok) return;
		assert.equal(res.row.type, DISCORD_COMPONENT_TYPE.actionRow);
		const select = (res.row.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(select.type, DISCORD_COMPONENT_TYPE.stringSelect);
		assert.equal(select.placeholder, "choose");
		// The custom_id carries the general callback prefix so a press routes back.
		const customId = String(select.custom_id);
		assert.ok(isGeneralCallbackData(customId), "custom_id is general-prefixed");
		assert.equal(decodeGeneralCallbackData(customId), "pick_color", "decodes back to the token");
		const options = select.options as Array<Record<string, unknown>>;
		assert.equal(options.length, 2);
		assert.equal(options[0]!.label, "Red");
		assert.equal(options[1]!.description, "the cool one");
	});

	it("builds an entity (user) select with the right component type + NO options", () => {
		const res = serializeDiscordSelectRow({ kind: "user", customId: "pick_user", minValues: 1, maxValues: 3 });
		assert.ok(res.ok);
		if (!res.ok) return;
		const select = (res.row.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(select.type, DISCORD_COMPONENT_TYPE.userSelect);
		assert.equal(select.min_values, 1);
		assert.equal(select.max_values, 3);
		assert.equal(select.options, undefined, "entity selects carry no static options");
	});

	it("errors for a string select with no usable option", () => {
		const res = serializeDiscordSelectRow({ kind: "string", customId: "x", options: [] });
		assert.equal(res.ok, false);
	});

	it("errors for an empty customId", () => {
		const res = serializeDiscordSelectRow({ kind: "role", customId: "  " });
		assert.equal(res.ok, false);
	});

	it("caps a string select at 25 options", () => {
		const options = Array.from({ length: 40 }, (_v, i) => ({ label: `o${i}`, value: `${i}` }));
		const res = serializeDiscordSelectRow({ kind: "string", customId: "big", options });
		assert.ok(res.ok);
		if (!res.ok) return;
		const select = (res.row.components as Array<Record<string, unknown>>)[0]!;
		assert.equal((select.options as unknown[]).length, 25);
	});
});

describe("serializeDiscordModalTrigger", () => {
	beforeEach(() => __resetDiscordModalRegistryForTest());
	afterEach(() => __resetDiscordModalRegistryForTest());

	it("registers a modal entry + emits a modal:<id> trigger button", () => {
		const res = serializeDiscordModalTrigger({
			buttonLabel: "Open form",
			title: "Feedback",
			fields: [{ id: "name", label: "Your name" }],
		});
		assert.ok(res.ok, "serialized");
		if (!res.ok) return;
		const button = (res.row.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(button.type, DISCORD_COMPONENT_TYPE.button);
		const customId = String(button.custom_id);
		assert.ok(isDiscordModalCustomId(customId), "custom_id is a modal marker");
		assert.equal(decodeDiscordModalCustomId(customId), res.modalId, "marker decodes to the minted id");
		// The heavy form definition is in the registry, keyed by the minted id.
		const entry = getDiscordModal(res.modalId);
		assert.ok(entry, "modal registered");
		assert.equal(entry!.title, "Feedback");
		assert.equal(entry!.fields.length, 1);
	});

	it("errors for an empty button label", () => {
		const res = serializeDiscordModalTrigger({ buttonLabel: "  ", fields: [{ id: "x", label: "X" }] });
		assert.equal(res.ok, false);
	});

	it("errors when no fields are supplied", () => {
		const res = serializeDiscordModalTrigger({ buttonLabel: "Go", fields: [] });
		assert.equal(res.ok, false);
	});
});

describe("serializeDiscordV2Message", () => {
	it("builds a container + sets the IsComponentsV2 flag and moves text into TextDisplay", () => {
		const res = serializeDiscordV2Message({
			accentColor: 5793266,
			blocks: [
				{ type: "text", text: "Hello world" },
				{ type: "separator", spacing: "large", divider: true },
				{ type: "section", texts: ["a", "b"], accessory: { kind: "thumbnail", url: "https://x/y.png" } },
				{ type: "actions", buttons: [{ label: "Docs", url: "https://example.com" }] },
				{ type: "media-gallery", items: [{ url: "https://x/img.png", spoiler: true }] },
			],
		});
		assert.ok(res.ok, "serialized");
		if (!res.ok) return;
		assert.equal(res.flags, DISCORD_FLAG_IS_COMPONENTS_V2, "IsComponentsV2 flag set");
		assert.equal(res.components.length, 1, "single top-level container");
		const container = res.components[0]!;
		assert.equal(container.type, DISCORD_COMPONENT_TYPE.container);
		assert.equal(container.accent_color, 5793266);
		const children = container.components as Array<Record<string, unknown>>;
		// text → TextDisplay
		const text = children.find((c) => c.type === DISCORD_COMPONENT_TYPE.textDisplay)!;
		assert.equal(text.content, "Hello world");
		// separator spacing word → numeric (large = 2)
		const sep = children.find((c) => c.type === DISCORD_COMPONENT_TYPE.separator)!;
		assert.equal(sep.spacing, 2);
		assert.equal(sep.divider, true);
		// section with a thumbnail accessory
		const section = children.find((c) => c.type === DISCORD_COMPONENT_TYPE.section)!;
		assert.equal((section.components as unknown[]).length, 2);
		assert.equal((section.accessory as Record<string, unknown>).type, DISCORD_COMPONENT_TYPE.thumbnail);
		// link button in an actions row
		const actions = children.find((c) => c.type === DISCORD_COMPONENT_TYPE.actionRow)!;
		const link = (actions.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(link.style, 5, "link button style");
		assert.equal(link.url, "https://example.com");
		// media gallery item uses { media: { url } }
		const gallery = children.find((c) => c.type === DISCORD_COMPONENT_TYPE.mediaGallery)!;
		const item = (gallery.items as Array<Record<string, unknown>>)[0]!;
		assert.deepEqual(item.media, { url: "https://x/img.png" });
		assert.equal(item.spoiler, true);
	});

	it("errors for an all-empty blocks spec", () => {
		const res = serializeDiscordV2Message({ blocks: [{ type: "text", text: "   " }] });
		assert.equal(res.ok, false);
	});
});
