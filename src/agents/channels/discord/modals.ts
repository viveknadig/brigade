/**
 * Discord modal (form) building + submission decoding (Fix 3b).
 *
 * A modal is opened with `interaction.showModal(modal)` in response to a button
 * press; on submit Discord delivers a `ModalSubmitInteraction` whose `fields`
 * accessor yields each text input's value keyed by the field's custom_id. This
 * module:
 *   - {@link buildDiscordModal} turns a registry {@link DiscordModalEntry} into a
 *     discord.js `ModalBuilder` (text inputs only — Discord's STABLE modals
 *     support only text inputs, which is correct for v1). It takes the discord.js
 *     builder constructors as an argument so a non-Discord boot never imports
 *     them and tests can inject lightweight fakes.
 *   - {@link extractModalFieldValues} reads the submitted values off a
 *     `ModalSubmitInteraction` defensively (pure — no discord.js).
 *   - {@link formatModalSubmissionText} renders a readable turn body from the
 *     entry's field labels + the submitted values (pure).
 *
 * The submission is routed as a NORMAL inbound message (`onMessage`) carrying the
 * formatted text — a filled form is a typed turn, not a button tap — so the agent
 * sees the labels + values exactly as a person would type them.
 */

import { DISCORD_TEXT_INPUT_STYLE, type DiscordModalEntry, type DiscordModalField } from "./modal-registry.js";

/** The custom_id key the modal itself carries: `modal:<modalId>`. */
export const DISCORD_MODAL_CUSTOM_ID_PREFIX = "modal:";

/** Wrap a modal id into the modal's custom_id marker. */
export function buildDiscordModalCustomId(modalId: string): string {
	return `${DISCORD_MODAL_CUSTOM_ID_PREFIX}${modalId}`;
}

/** True when a pressed-button / submitted-modal custom_id is a modal marker. */
export function isDiscordModalCustomId(value: string | undefined): boolean {
	return typeof value === "string" && value.startsWith(DISCORD_MODAL_CUSTOM_ID_PREFIX);
}

/** Strip the marker, returning the modal id (or "" when not a modal marker). */
export function decodeDiscordModalCustomId(value: string | undefined): string {
	if (!isDiscordModalCustomId(value)) return "";
	return (value as string).slice(DISCORD_MODAL_CUSTOM_ID_PREFIX.length);
}

/** Discord caps a modal title at 45 chars + a text-input label at 45 chars. */
const DISCORD_MODAL_TITLE_MAX = 45;
const DISCORD_MODAL_LABEL_MAX = 45;

/**
 * The discord.js builder constructors {@link buildDiscordModal} needs. Injected
 * (rather than imported) so a non-Discord boot never loads discord.js and tests
 * inject fakes. The real values are `discord.ModalBuilder`, `ActionRowBuilder`,
 * and `TextInputBuilder`.
 */
export interface DiscordModalBuilderDeps {
	ModalBuilder: new () => DiscordModalBuilderLike;
	ActionRowBuilder: new () => DiscordModalRowBuilderLike;
	TextInputBuilder: new () => DiscordTextInputBuilderLike;
}

interface DiscordModalBuilderLike {
	setCustomId(id: string): this;
	setTitle(title: string): this;
	addComponents(...rows: unknown[]): this;
}
interface DiscordModalRowBuilderLike {
	addComponents(...inputs: unknown[]): this;
}
interface DiscordTextInputBuilderLike {
	setCustomId(id: string): this;
	setLabel(label: string): this;
	setStyle(style: number): this;
	setRequired(required: boolean): this;
	setPlaceholder(placeholder: string): this;
}

/**
 * Build a discord.js `ModalBuilder` from a registry entry. Each field becomes a
 * `TextInputBuilder` in its own `ActionRowBuilder` (Discord requires one input
 * per row). Title + labels are capped to Discord's limits. `title` is the modal
 * heading; pass it explicitly since the registry stores the form fields, not the
 * heading.
 */
export function buildDiscordModal(
	deps: DiscordModalBuilderDeps,
	params: { modalId: string; title: string; entry: DiscordModalEntry },
): DiscordModalBuilderLike {
	const modal = new deps.ModalBuilder()
		.setCustomId(buildDiscordModalCustomId(params.modalId))
		.setTitle((params.title || "Form").slice(0, DISCORD_MODAL_TITLE_MAX));
	const rows: unknown[] = [];
	for (const field of params.entry.fields) {
		const input = new deps.TextInputBuilder()
			.setCustomId(field.id)
			.setLabel((field.label || field.id).slice(0, DISCORD_MODAL_LABEL_MAX))
			.setStyle(field.style === "paragraph" ? DISCORD_TEXT_INPUT_STYLE.paragraph : DISCORD_TEXT_INPUT_STYLE.short)
			.setRequired(field.required !== false);
		if (field.placeholder) input.setPlaceholder(field.placeholder);
		const row = new deps.ActionRowBuilder().addComponents(input);
		rows.push(row);
	}
	modal.addComponents(...rows);
	return modal;
}

/** The minimal `ModalSubmitInteraction.fields` surface we read. */
interface DiscordModalSubmitFieldsLike {
	/** discord.js: returns the submitted string value for a field custom_id. */
	getTextInputValue?: (customId: string) => string;
	/** Some shapes expose a raw field collection; read it as a fallback. */
	fields?: Map<string, { value?: string }> | Iterable<{ customId?: string; value?: string }>;
}

/**
 * Pull the submitted `{ fieldId → value }` map off a modal-submit interaction,
 * for the given entry's fields. Reads via `getTextInputValue` first (the stable
 * discord.js accessor), falling back to a raw fields collection. Fully guarded —
 * a missing value yields "".
 */
export function extractModalFieldValues(
	interaction: { fields?: DiscordModalSubmitFieldsLike } | undefined,
	fields: DiscordModalField[],
): Record<string, string> {
	const out: Record<string, string> = {};
	const accessor = interaction?.fields;
	// Build a fallback id→value map from a raw collection once, if present.
	const fallback = new Map<string, string>();
	const rawFields = accessor?.fields;
	if (rawFields) {
		if (rawFields instanceof Map) {
			for (const [id, v] of rawFields) fallback.set(id, typeof v?.value === "string" ? v.value : "");
		} else {
			for (const v of rawFields as Iterable<{ customId?: string; value?: string }>) {
				if (typeof v?.customId === "string") fallback.set(v.customId, typeof v.value === "string" ? v.value : "");
			}
		}
	}
	for (const field of fields) {
		let value = "";
		if (typeof accessor?.getTextInputValue === "function") {
			try {
				value = accessor.getTextInputValue(field.id) ?? "";
			} catch {
				value = fallback.get(field.id) ?? "";
			}
		} else {
			value = fallback.get(field.id) ?? "";
		}
		out[field.id] = typeof value === "string" ? value : "";
	}
	return out;
}

/**
 * Render a readable turn body from a modal submission. Each filled field is a
 * `Label: value` line; an empty field is shown as `Label: (empty)` so the agent
 * sees the full form. A leading `[form]` marker tags the turn like `[button]`
 * does for a tap, so the agent can recognize a form submission.
 */
export function formatModalSubmissionText(
	entry: { fields: DiscordModalField[] },
	values: Record<string, string>,
): string {
	const lines: string[] = ["[form]"];
	for (const field of entry.fields) {
		const raw = values[field.id];
		const value = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "(empty)";
		lines.push(`${field.label || field.id}: ${value}`);
	}
	return lines.join("\n");
}

export type { DiscordModalField };
