/**
 * Discord Components-V2 layout-block specs (Fix 3c).
 *
 * Components V2 lets a message carry rich layout — containers, sections,
 * separators, media galleries, files, and free-standing text — instead of a
 * plain `content` string + button rows. A V2 message MUST set the
 * `IsComponentsV2` flag and CANNOT carry plain `content`; all text moves into
 * `TextDisplay` blocks. Link buttons (a button with a `url` + no custom_id) are
 * the one button kind that fits naturally in a V2 layout.
 *
 * This module mirrors `components.ts`: it emits PLAIN serializable specs (a
 * `DiscordBlockSpec` list) and never imports discord.js, so it stays pure +
 * unit-testable. The connection turns each spec into the matching discord.js V2
 * builder at send time (`ContainerBuilder` / `SectionBuilder` / `SeparatorBuilder`
 * / `TextDisplayBuilder` / `MediaGalleryBuilder` / `FileBuilder`).
 *
 * Pure / deterministic — no I/O, no globals.
 */

import { DISCORD_BUTTON_STYLE, type DiscordButtonStyleValue } from "./components.js";

/** `MessageFlags.IsComponentsV2` (1 << 15). A V2 message sets this + drops plain content. */
export const DISCORD_FLAG_IS_COMPONENTS_V2 = 1 << 15;

/** discord.js `ButtonStyle.Link` value (a URL button, no custom_id). */
export const DISCORD_BUTTON_STYLE_LINK = 5;

/** A link button — opens a URL; carries NO custom_id, so it never routes a turn. */
export interface DiscordLinkButtonSpec {
	/** Button label (≤ 80 chars). */
	label: string;
	/** Destination URL. */
	url: string;
}

/** An interactive button inside a V2 actions block (general-prefixed customId). */
export interface DiscordV2ButtonSpec {
	label: string;
	/** Already general-prefixed + sanitized customId (a press routes a turn). */
	customId: string;
	style?: DiscordButtonStyleValue;
}

/** A media-gallery item (an image/video URL + optional alt + spoiler). */
export interface DiscordMediaItem {
	url: string;
	description?: string;
	spoiler?: boolean;
}

/**
 * A single V2 layout block. Discriminated by `type`. Sections may carry an
 * optional accessory (a thumbnail URL or a button). `actions` carries link
 * and/or interactive buttons.
 */
export type DiscordBlockSpec =
	| { type: "text"; text: string }
	| {
			type: "section";
			/** One to three text lines rendered in the section body. */
			texts: string[];
			accessory?: { kind: "thumbnail"; url: string } | { kind: "button"; button: DiscordLinkButtonSpec | DiscordV2ButtonSpec };
	  }
	| { type: "separator"; divider?: boolean; spacing?: "small" | "large" }
	| { type: "actions"; buttons: Array<DiscordLinkButtonSpec | DiscordV2ButtonSpec> }
	| { type: "media-gallery"; items: DiscordMediaItem[] }
	| { type: "file"; url: `attachment://${string}`; spoiler?: boolean };

/**
 * A serializable Components-V2 message spec — a `container` (the top-level V2
 * wrapper) holding ordered blocks. The connection wraps it in a single
 * `ContainerBuilder` and sets the V2 flag. `accentColor` tints the container
 * stripe (a Discord color int).
 */
export interface DiscordV2MessageSpec {
	/** Discriminator marking this row as a V2 container (vs a button/select row). */
	readonly row: "v2";
	blocks: DiscordBlockSpec[];
	accentColor?: number;
}

/** True when a `buildComponentRows` entry is a V2 container marker. */
export function isDiscordV2MessageSpec(row: unknown): row is DiscordV2MessageSpec {
	return typeof row === "object" && row !== null && (row as { row?: unknown }).row === "v2";
}

/** True when a button spec is a LINK button (URL, no custom_id). */
export function isDiscordLinkButton(b: DiscordLinkButtonSpec | DiscordV2ButtonSpec): b is DiscordLinkButtonSpec {
	return typeof (b as DiscordLinkButtonSpec).url === "string" && (b as DiscordLinkButtonSpec).url.length > 0;
}

/** The attachment-ref prefix a `file` block expects (Discord requires it). */
export const DISCORD_ATTACHMENT_REF_PREFIX = "attachment://";

const DISCORD_BUTTON_LABEL_MAX = 80;
const DISCORD_SECTION_MAX_TEXTS = 3;

/**
 * Shape a high-level V2 message into a serializable container spec, or `null`
 * when nothing renderable remains. Defensive caps mirror Discord's limits
 * (section ≤ 3 texts, button label ≤ 80). A `file` block whose url isn't an
 * `attachment://` ref is dropped (Discord rejects external file refs). Returns
 * `null` when the resulting container would be empty so the caller can fall back
 * to a plain text send.
 */
export function buildDiscordV2Message(spec: { blocks: DiscordBlockSpec[]; accentColor?: number }): DiscordV2MessageSpec | null {
	const blocks: DiscordBlockSpec[] = [];
	for (const block of spec?.blocks ?? []) {
		if (!block || typeof block !== "object") continue;
		switch (block.type) {
			case "text": {
				const text = (block.text ?? "").trim();
				if (text) blocks.push({ type: "text", text });
				break;
			}
			case "section": {
				const texts = (block.texts ?? []).map((t) => (t ?? "").trim()).filter((t) => t.length > 0).slice(0, DISCORD_SECTION_MAX_TEXTS);
				if (texts.length === 0) break;
				const out: Extract<DiscordBlockSpec, { type: "section" }> = { type: "section", texts };
				if (block.accessory) out.accessory = block.accessory;
				blocks.push(out);
				break;
			}
			case "separator": {
				const out: Extract<DiscordBlockSpec, { type: "separator" }> = { type: "separator" };
				if (typeof block.divider === "boolean") out.divider = block.divider;
				if (block.spacing) out.spacing = block.spacing;
				blocks.push(out);
				break;
			}
			case "actions": {
				const buttons = (block.buttons ?? [])
					.filter((b) => b && typeof b.label === "string" && b.label.trim().length > 0)
					.map((b) => {
						const label = b.label.trim().slice(0, DISCORD_BUTTON_LABEL_MAX);
						return isDiscordLinkButton(b) ? { label, url: b.url } : { label, customId: b.customId, style: b.style ?? DISCORD_BUTTON_STYLE.Secondary };
					});
				if (buttons.length > 0) blocks.push({ type: "actions", buttons });
				break;
			}
			case "media-gallery": {
				const items = (block.items ?? []).filter((it) => it && typeof it.url === "string" && it.url.length > 0);
				if (items.length > 0) blocks.push({ type: "media-gallery", items });
				break;
			}
			case "file": {
				const url = block.url ?? "";
				if (typeof url === "string" && url.startsWith(DISCORD_ATTACHMENT_REF_PREFIX)) {
					const out: Extract<DiscordBlockSpec, { type: "file" }> = { type: "file", url };
					if (typeof block.spoiler === "boolean") out.spoiler = block.spoiler;
					blocks.push(out);
				}
				break;
			}
			default:
				break;
		}
	}
	if (blocks.length === 0) return null;
	const out: DiscordV2MessageSpec = { row: "v2", blocks };
	if (typeof spec.accentColor === "number" && Number.isFinite(spec.accentColor)) out.accentColor = spec.accentColor;
	return out;
}
