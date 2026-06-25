import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	__resetDiscordModalRegistryForTest,
	consumeDiscordModal,
	getDiscordModal,
	MODAL_ENTRY_TTL_MS,
	registerDiscordModal,
} from "./modal-registry.js";
import {
	buildDiscordModal,
	buildDiscordModalCustomId,
	decodeDiscordModalCustomId,
	extractModalFieldValues,
	formatModalSubmissionText,
	isDiscordModalCustomId,
	type DiscordModalBuilderDeps,
} from "./modals.js";

describe("modal-registry (Fix 3b)", () => {
	it("registers, peeks, and consumes a modal entry", () => {
		__resetDiscordModalRegistryForTest();
		const id = registerDiscordModal({ title: "T", fields: [{ id: "a", label: "A" }], sessionKey: "s1" });
		assert.equal(getDiscordModal(id)?.sessionKey, "s1");
		// peek does not remove
		assert.ok(getDiscordModal(id));
		const consumed = consumeDiscordModal(id);
		assert.equal(consumed?.title, "T");
		// single-use: a second consume is undefined
		assert.equal(consumeDiscordModal(id), undefined);
		assert.equal(getDiscordModal(id), undefined);
	});

	it("defaults the title to Form + caps fields at 5", () => {
		__resetDiscordModalRegistryForTest();
		const id = registerDiscordModal({ fields: Array.from({ length: 8 }, (_v, i) => ({ id: `f${i}`, label: `L${i}` })) });
		const entry = getDiscordModal(id);
		assert.equal(entry?.title, "Form");
		assert.equal(entry?.fields.length, 5);
	});

	it("expires an entry after the TTL", () => {
		let now = 1_000;
		__resetDiscordModalRegistryForTest(() => now);
		const id = registerDiscordModal({ fields: [{ id: "a", label: "A" }] });
		assert.ok(getDiscordModal(id));
		now += MODAL_ENTRY_TTL_MS + 1;
		assert.equal(getDiscordModal(id), undefined, "an expired entry is reaped");
	});

	it("a missing id degrades gracefully", () => {
		__resetDiscordModalRegistryForTest();
		assert.equal(getDiscordModal("nope"), undefined);
		assert.equal(consumeDiscordModal("nope"), undefined);
	});
});

describe("modal custom_id codec (Fix 3b)", () => {
	it("round-trips a modal id through the marker", () => {
		const cid = buildDiscordModalCustomId("m9");
		assert.equal(isDiscordModalCustomId(cid), true);
		assert.equal(decodeDiscordModalCustomId(cid), "m9");
		assert.equal(isDiscordModalCustomId("g:notamodal"), false);
		assert.equal(decodeDiscordModalCustomId("g:notamodal"), "");
	});
});

describe("buildDiscordModal (Fix 3b)", () => {
	it("builds a ModalBuilder with one text input per field via injected builders", () => {
		// Lightweight fakes capturing the builder calls.
		const calls: string[] = [];
		class FakeModal {
			customId = "";
			title = "";
			rows: unknown[] = [];
			setCustomId(id: string) {
				this.customId = id;
				return this;
			}
			setTitle(t: string) {
				this.title = t;
				return this;
			}
			addComponents(...rows: unknown[]) {
				this.rows.push(...rows);
				return this;
			}
		}
		class FakeRow {
			inputs: unknown[] = [];
			addComponents(...i: unknown[]) {
				this.inputs.push(...i);
				return this;
			}
		}
		class FakeInput {
			id = "";
			label = "";
			style = 0;
			required = true;
			placeholder = "";
			setCustomId(id: string) {
				this.id = id;
				calls.push(`id:${id}`);
				return this;
			}
			setLabel(l: string) {
				this.label = l;
				return this;
			}
			setStyle(s: number) {
				this.style = s;
				return this;
			}
			setRequired(r: boolean) {
				this.required = r;
				return this;
			}
			setPlaceholder(p: string) {
				this.placeholder = p;
				return this;
			}
		}
		const deps: DiscordModalBuilderDeps = {
			ModalBuilder: FakeModal as never,
			ActionRowBuilder: FakeRow as never,
			TextInputBuilder: FakeInput as never,
		};
		const entry = {
			title: "Feedback",
			fields: [
				{ id: "name", label: "Your name", required: true },
				{ id: "msg", label: "Message", style: "paragraph" as const, required: false, placeholder: "Say hi" },
			],
			createdAt: 0,
			expiresAt: 0,
		};
		const modal = buildDiscordModal(deps, { modalId: "m1", title: "Feedback", entry }) as unknown as FakeModal;
		assert.equal(modal.customId, "modal:m1");
		assert.equal(modal.title, "Feedback");
		assert.equal(modal.rows.length, 2, "one ActionRow per field");
		assert.deepEqual(calls, ["id:name", "id:msg"]);
		const secondInput = (modal.rows[1] as FakeRow).inputs[0] as FakeInput;
		assert.equal(secondInput.style, 2, "paragraph style");
		assert.equal(secondInput.required, false);
		assert.equal(secondInput.placeholder, "Say hi");
	});
});

describe("extractModalFieldValues + formatModalSubmissionText (Fix 3b)", () => {
	const fields = [
		{ id: "name", label: "Name" },
		{ id: "msg", label: "Message" },
	];

	it("reads values via getTextInputValue", () => {
		const interaction = {
			fields: {
				getTextInputValue: (id: string) => (id === "name" ? "Ada" : "hi there"),
			},
		};
		const values = extractModalFieldValues(interaction, fields);
		assert.deepEqual(values, { name: "Ada", msg: "hi there" });
		const text = formatModalSubmissionText({ fields }, values);
		assert.match(text, /^\[form\]/);
		assert.match(text, /Name: Ada/);
		assert.match(text, /Message: hi there/);
	});

	it("falls back to a raw fields collection + shows (empty) for blanks", () => {
		const interaction = {
			fields: {
				fields: new Map([["name", { value: "Bob" }]]),
			},
		};
		const values = extractModalFieldValues(interaction, fields);
		assert.equal(values.name, "Bob");
		assert.equal(values.msg, "");
		const text = formatModalSubmissionText({ fields }, values);
		assert.match(text, /Message: \(empty\)/);
	});
});
