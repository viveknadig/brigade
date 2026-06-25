/**
 * Discord REST-JSON component serializers (Fix A1).
 *
 * The Phase-3 builders (`components.ts` / `component-blocks.ts`) emit discord.js
 * *Builder* objects for the GATEWAY `sendInteractive` path. The `discord_action`
 * tool, however, talks straight to Discord REST v10 (`rest-actions.ts`), which
 * needs RAW component JSON — the on-the-wire shape Discord documents, identical
 * whether discord.js serialized it or we did.
 *
 * This module turns high-level STRUCTURED specs (selects / modal triggers / V2
 * blocks) into that raw JSON, carrying the SAME custom_id codecs the press-
 * routing in `connection.ts handleInteraction` already understands:
 *
 *   - SELECT rows get a `custom_id` prefixed with {@link GENERAL_CALLBACK_PREFIX}
 *     (via {@link buildDiscordSelectRow}) so a selection routes through the
 *     general-callback branch → `callbackQuery{ data, values }`.
 *   - MODAL triggers register the heavy form in `modal-registry.ts` and emit a
 *     button whose `custom_id` is the `modal:<id>` marker `handleInteraction`
 *     recognizes → `showModal`.
 *   - V2 blocks become Components-V2 JSON; the caller sets the `IsComponentsV2`
 *     message flag (1 << 15) and moves all text into TextDisplay blocks.
 *
 * Pure / deterministic — no I/O, no discord.js, no globals. Returns a discriminated
 * result so the tool can surface a clean validation error instead of shipping a
 * half-built component Discord would 400 on.
 */

import {
	DISCORD_BUTTON_STYLE,
	DISCORD_MAX_ROWS,
	DISCORD_SELECT_COMPONENT_TYPE,
	buildDiscordSelectRow,
	type DiscordButtonStyleValue,
	type DiscordSelectKind,
	type DiscordSelectOption,
} from "./components.js";
import {
	DISCORD_FLAG_IS_COMPONENTS_V2,
	DISCORD_BUTTON_STYLE_LINK,
	buildDiscordV2Message,
	type DiscordBlockSpec,
	type DiscordLinkButtonSpec,
	type DiscordV2ButtonSpec,
} from "./component-blocks.js";
import { registerDiscordModal, type DiscordModalRegistration } from "./modal-registry.js";
import { buildDiscordModalCustomId } from "./modals.js";

/** Discord component-type ids on the wire (v10). */
export const DISCORD_COMPONENT_TYPE = {
	actionRow: 1,
	button: 2,
	stringSelect: 3,
	textInput: 4,
	userSelect: 5,
	roleSelect: 6,
	mentionableSelect: 7,
	channelSelect: 8,
	section: 9,
	textDisplay: 10,
	thumbnail: 11,
	mediaGallery: 12,
	file: 13,
	separator: 14,
	container: 17,
} as const;

/** Discord caps a message at 5 select rows / 5 action rows. */
export const DISCORD_MAX_SELECT_ROWS = DISCORD_MAX_ROWS;
/** Discord caps a string select at 25 options. */
export const DISCORD_MAX_SELECT_OPTIONS = 25;

/* ───────────────────────── structured input specs ───────────────────────── */

/** The structured `select` spec the tool accepts (validated → REST JSON). */
export interface DiscordSelectInput {
	kind: DiscordSelectKind;
	/** App-defined token (the tool prefixes it with the general marker on press-routing). */
	customId: string;
	placeholder?: string;
	minValues?: number;
	maxValues?: number;
	options?: DiscordSelectOption[];
}

/** The structured `modal` spec the tool accepts (registered + a trigger button emitted). */
export interface DiscordModalInput {
	/** Trigger button label. */
	buttonLabel: string;
	title?: string;
	fields: DiscordModalRegistration["fields"];
	sessionKey?: string;
	agentId?: string;
	accountId?: string;
	allowedUsers?: string[];
	buttonStyle?: DiscordButtonStyleValue;
}

/** The structured `blocks` (Components-V2) spec the tool accepts. */
export interface DiscordBlocksInput {
	blocks: DiscordBlockSpec[];
	accentColor?: number;
}

/** A failure result — the caller renders `error` instead of shipping bad JSON. */
export interface DiscordRestComponentError {
	ok: false;
	error: string;
}

/* ───────────────────────────── select → JSON ───────────────────────────── */

/**
 * Serialize one structured select spec into a Discord action-row JSON object
 * wrapping a select component. The select's `custom_id` carries the general
 * callback prefix (via {@link buildDiscordSelectRow}) so a press routes through
 * the existing select branch in `handleInteraction`. Returns an error result when
 * the spec is unusable (empty token / over-budget id / a string select with no
 * usable option).
 */
export function serializeDiscordSelectRow(
	input: DiscordSelectInput,
): { ok: true; row: Record<string, unknown> } | DiscordRestComponentError {
	const cappedOptions =
		input.kind === "string" && Array.isArray(input.options)
			? input.options.slice(0, DISCORD_MAX_SELECT_OPTIONS)
			: input.options;
	const spec = buildDiscordSelectRow({
		kind: input.kind,
		customIdToken: input.customId,
		...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
		...(typeof input.minValues === "number" ? { minValues: input.minValues } : {}),
		...(typeof input.maxValues === "number" ? { maxValues: input.maxValues } : {}),
		...(cappedOptions ? { options: cappedOptions } : {}),
	});
	if (!spec) {
		return {
			ok: false,
			error:
				input.kind === "string"
					? "select requires a non-empty customId and at least one option with a label + value."
					: "select requires a non-empty customId that fits Discord's 100-char custom_id budget.",
		};
	}

	const componentType = DISCORD_SELECT_COMPONENT_TYPE[spec.kind];
	const select: Record<string, unknown> = {
		type: componentType,
		custom_id: spec.customId,
	};
	if (spec.placeholder) select.placeholder = spec.placeholder;
	if (typeof spec.minValues === "number") select.min_values = spec.minValues;
	if (typeof spec.maxValues === "number") select.max_values = spec.maxValues;
	if (spec.kind === "string" && spec.options) {
		select.options = spec.options.map((opt) => ({
			label: opt.label,
			value: opt.value,
			...(opt.description ? { description: opt.description } : {}),
		}));
	}
	return { ok: true, row: { type: DISCORD_COMPONENT_TYPE.actionRow, components: [select] } };
}

/* ───────────────────────────── modal → JSON ───────────────────────────── */

/**
 * Register the modal definition in the TTL registry and serialize the
 * MODAL-TRIGGER button into a Discord action-row JSON object. The button's
 * `custom_id` is the `modal:<id>` marker `handleInteraction` recognizes → it
 * calls `showModal` instead of routing a turn. Returns the row JSON + the minted
 * modal id, or an error when the spec is unusable (empty label / no field).
 */
export function serializeDiscordModalTrigger(
	input: DiscordModalInput,
): { ok: true; row: Record<string, unknown>; modalId: string } | DiscordRestComponentError {
	const label = (input.buttonLabel ?? "").trim();
	if (!label) return { ok: false, error: "modal requires a non-empty buttonLabel." };
	const fields = Array.isArray(input.fields) ? input.fields.filter((f) => f && typeof f.id === "string" && f.id.trim()) : [];
	if (fields.length === 0) return { ok: false, error: "modal requires at least one field with an id." };

	const modalId = registerDiscordModal({
		...(input.title !== undefined ? { title: input.title } : {}),
		fields,
		...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
		...(input.allowedUsers !== undefined ? { allowedUsers: input.allowedUsers } : {}),
	});
	const button: Record<string, unknown> = {
		type: DISCORD_COMPONENT_TYPE.button,
		style: input.buttonStyle ?? DISCORD_BUTTON_STYLE.Primary,
		label: label.slice(0, 80),
		custom_id: buildDiscordModalCustomId(modalId),
	};
	return { ok: true, row: { type: DISCORD_COMPONENT_TYPE.actionRow, components: [button] }, modalId };
}

/* ───────────────────────────── V2 blocks → JSON ───────────────────────────── */

/** Serialize one V2 button (link OR general-prefixed interactive) into wire JSON. */
function serializeV2Button(b: DiscordLinkButtonSpec | DiscordV2ButtonSpec): Record<string, unknown> {
	if (typeof (b as DiscordLinkButtonSpec).url === "string" && (b as DiscordLinkButtonSpec).url.length > 0) {
		const link = b as DiscordLinkButtonSpec;
		return { type: DISCORD_COMPONENT_TYPE.button, style: DISCORD_BUTTON_STYLE_LINK, label: link.label, url: link.url };
	}
	const btn = b as DiscordV2ButtonSpec;
	return {
		type: DISCORD_COMPONENT_TYPE.button,
		style: btn.style ?? DISCORD_BUTTON_STYLE.Secondary,
		label: btn.label,
		custom_id: btn.customId,
	};
}

/** Map a separator spacing word to Discord's numeric spacing (1=small, 2=large). */
function separatorSpacing(spacing?: "small" | "large"): number | undefined {
	if (spacing === "small") return 1;
	if (spacing === "large") return 2;
	return undefined;
}

/** Serialize one validated V2 block into its Discord wire-JSON component object. */
function serializeV2Block(block: DiscordBlockSpec): Record<string, unknown> | null {
	switch (block.type) {
		case "text":
			return { type: DISCORD_COMPONENT_TYPE.textDisplay, content: block.text };
		case "section": {
			const out: Record<string, unknown> = {
				type: DISCORD_COMPONENT_TYPE.section,
				components: block.texts.map((t) => ({ type: DISCORD_COMPONENT_TYPE.textDisplay, content: t })),
			};
			if (block.accessory) {
				if (block.accessory.kind === "thumbnail") {
					out.accessory = { type: DISCORD_COMPONENT_TYPE.thumbnail, media: { url: block.accessory.url } };
				} else {
					out.accessory = serializeV2Button(block.accessory.button);
				}
			}
			return out;
		}
		case "separator": {
			const out: Record<string, unknown> = { type: DISCORD_COMPONENT_TYPE.separator };
			if (typeof block.divider === "boolean") out.divider = block.divider;
			const spacing = separatorSpacing(block.spacing);
			if (spacing !== undefined) out.spacing = spacing;
			return out;
		}
		case "actions":
			return {
				type: DISCORD_COMPONENT_TYPE.actionRow,
				components: block.buttons.map((b) => serializeV2Button(b)),
			};
		case "media-gallery":
			return {
				type: DISCORD_COMPONENT_TYPE.mediaGallery,
				items: block.items.map((it) => ({
					media: { url: it.url },
					...(it.description ? { description: it.description } : {}),
					...(it.spoiler ? { spoiler: true } : {}),
				})),
			};
		case "file": {
			const out: Record<string, unknown> = { type: DISCORD_COMPONENT_TYPE.file, file: { url: block.url } };
			if (typeof block.spoiler === "boolean") out.spoiler = block.spoiler;
			return out;
		}
		default:
			return null;
	}
}

/**
 * Serialize a structured V2 (`blocks`) spec into a Components-V2 message body
 * fragment: a single top-level CONTAINER (type 17) holding the serialized blocks,
 * plus the {@link DISCORD_FLAG_IS_COMPONENTS_V2} flag the caller ORs into the
 * message `flags`. The high-level spec is validated through
 * {@link buildDiscordV2Message} first (drops empty blocks, caps section texts,
 * rejects non-`attachment://` file refs); an empty container yields an error so
 * the caller can fall back to a plain text send.
 */
export function serializeDiscordV2Message(
	input: DiscordBlocksInput,
): { ok: true; components: Array<Record<string, unknown>>; flags: number } | DiscordRestComponentError {
	const spec = buildDiscordV2Message({
		blocks: input.blocks ?? [],
		...(typeof input.accentColor === "number" ? { accentColor: input.accentColor } : {}),
	});
	if (!spec) {
		return { ok: false, error: "blocks produced no renderable Components-V2 content." };
	}
	const children: Array<Record<string, unknown>> = [];
	for (const block of spec.blocks) {
		const serialized = serializeV2Block(block);
		if (serialized) children.push(serialized);
	}
	if (children.length === 0) {
		return { ok: false, error: "blocks produced no renderable Components-V2 content." };
	}
	const container: Record<string, unknown> = {
		type: DISCORD_COMPONENT_TYPE.container,
		components: children,
	};
	if (typeof spec.accentColor === "number") container.accent_color = spec.accentColor;
	return { ok: true, components: [container], flags: DISCORD_FLAG_IS_COMPONENTS_V2 };
}
