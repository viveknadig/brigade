/**
 * Discord message-component button rendering + the custom_id callback codec.
 *
 * Discord's analogue of `slack/blocks.ts`. Two button lanes share one builder,
 * exactly as Slack's do:
 *
 *   - APPROVAL buttons — payloads come from the CENTRAL approval codec
 *     (`buildApprovalCallbackButtons`), so a press resolves through the central
 *     `tryConsumeChannelApprovalCallback`. Built in `approval-native.ts`; this
 *     module only supplies the low-level row + button shapes.
 *   - GENERAL buttons — the agent attaches arbitrary buttons via the
 *     `message_action` `buttons` kind; a press routes back through the inbound
 *     pipeline as a normal turn. Every general payload is namespaced with
 *     {@link GENERAL_CALLBACK_PREFIX} so the pipeline can tell it apart from an
 *     approval press (which it consumes FIRST).
 *
 * WHERE THE PAYLOAD RIDES. A Discord button carries its opaque codec payload in
 * `custom_id` (Discord caps it at 100 chars). The central approval codec already
 * guarantees ≤64 UTF-8 bytes, so an approval payload always fits; a general
 * payload that exceeds the budget after prefixing is DROPPED (rather than ship a
 * truncated id that decodes to the wrong action on press). On press, discord.js
 * delivers the pressed `interaction.customId` verbatim, which the central
 * pipeline decodes — there is no separate routing id (unlike Slack's action_id).
 *
 * These builders emit PLAIN serializable specs (a `DiscordButtonSpec` grid); the
 * connection turns each into a discord.js `ActionRowBuilder<ButtonBuilder>` at
 * send time, so this module stays pure + dependency-light + unit-testable
 * without importing discord.js.
 *
 * Pure / deterministic — no I/O, no globals.
 */

import { GENERAL_CALLBACK_PREFIX } from "../general-callback.js";
import { registerDiscordModal, type DiscordModalRegistration } from "./modal-registry.js";
import { buildDiscordModalCustomId } from "./modals.js";

/** Discord caps a component `custom_id` at 100 chars. */
export const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

/** Discord allows at most 5 buttons per action row. */
export const DISCORD_BUTTONS_PER_ROW = 5;

/** Discord allows at most 5 action rows per message. */
export const DISCORD_MAX_ROWS = 5;

/** Discord button label cap (chars). */
const DISCORD_BUTTON_LABEL_MAX = 80;

/** Discord ButtonStyle enum values (mirrors discord.js `ButtonStyle`). */
export const DISCORD_BUTTON_STYLE = {
	Primary: 1,
	Secondary: 2,
	Success: 3,
	Danger: 4,
} as const;

export type DiscordButtonStyleValue = (typeof DISCORD_BUTTON_STYLE)[keyof typeof DISCORD_BUTTON_STYLE];

/** A single serializable Discord button spec (the connection turns it into a ButtonBuilder). */
export interface DiscordButtonSpec {
	/** Button label shown to the user (≤ 80 chars). */
	label: string;
	/** Opaque codec payload carried in `custom_id` (≤ 100 chars), read back on press. */
	customId: string;
	/** Discord button style (default Secondary). */
	style: DiscordButtonStyleValue;
}

/** One action row — up to 5 buttons. */
export type DiscordActionRow = DiscordButtonSpec[];

/* ───────────────────────── select-menu specs (Fix 3a) ───────────────────────── */

/** Discord ComponentType values for the five select-menu kinds (mirror discord.js). */
export const DISCORD_SELECT_COMPONENT_TYPE = {
	string: 3,
	user: 5,
	role: 6,
	mentionable: 7,
	channel: 8,
} as const;

/** The five select-menu kinds Brigade can emit. */
export type DiscordSelectKind = "string" | "user" | "role" | "channel" | "mentionable";

/** One option of a STRING select (entity selects have no static options). */
export interface DiscordSelectOption {
	/** Option label shown to the user. */
	label: string;
	/** Opaque value delivered back on selection (NOT the customId; the row's id routes). */
	value: string;
	/** Optional sublabel under the option. */
	description?: string;
}

/**
 * A serializable select-menu row spec (the connection turns it into a discord.js
 * `*SelectMenuBuilder` wrapped in its OWN `ActionRowBuilder` — a select must be
 * alone in its row). Like a general button, the select's `customId` carries a
 * {@link GENERAL_CALLBACK_PREFIX} token so a selection routes through the SAME
 * central general-callback path a button press does, just carrying `values`.
 */
export interface DiscordSelectSpec {
	/** Discriminator marking this row as a select (not a button grid). */
	readonly row: "select";
	/** Which select kind to render. */
	kind: DiscordSelectKind;
	/** Opaque codec payload carried in `custom_id` (already general-prefixed + ≤ 100 chars). */
	customId: string;
	/** Placeholder shown before a choice is made. */
	placeholder?: string;
	/** Min number of selections (Discord default 1). */
	minValues?: number;
	/** Max number of selections (Discord default 1). */
	maxValues?: number;
	/** STRING-select options (required + non-empty for `kind: "string"`; ignored otherwise). */
	options?: DiscordSelectOption[];
}

/** True when a `buildComponentRows` entry is a select-row marker (vs a button grid). */
export function isDiscordSelectSpec(row: unknown): row is DiscordSelectSpec {
	return typeof row === "object" && row !== null && (row as { row?: unknown }).row === "select";
}

/** Discord select placeholder cap (chars). */
const DISCORD_SELECT_PLACEHOLDER_MAX = 150;
/** Discord string-select option label/description caps (chars). */
const DISCORD_SELECT_OPTION_LABEL_MAX = 100;
const DISCORD_SELECT_OPTION_DESC_MAX = 100;

/**
 * Build a select-row marker from a high-level spec. The token is namespaced with
 * {@link GENERAL_CALLBACK_PREFIX} (exactly like a general button) + sanitized; a
 * token that overflows the 100-char budget OR a `string` select with no usable
 * option yields `null` (the caller falls back to a plain message rather than ship
 * a select that decodes to the wrong action / renders empty). Placeholder +
 * option text are capped to Discord's limits.
 */
export function buildDiscordSelectRow(spec: {
	kind: DiscordSelectKind;
	customIdToken: string;
	placeholder?: string;
	minValues?: number;
	maxValues?: number;
	options?: DiscordSelectOption[];
}): DiscordSelectSpec | null {
	const token = (spec?.customIdToken ?? "").trim();
	if (!token) return null;
	const prefixed = sanitizeDiscordCustomId(`${GENERAL_CALLBACK_PREFIX}${token}`);
	if (!prefixed || prefixed.length > DISCORD_CUSTOM_ID_MAX_CHARS) return null;

	let options: DiscordSelectOption[] | undefined;
	if (spec.kind === "string") {
		const shaped: DiscordSelectOption[] = [];
		for (const opt of spec.options ?? []) {
			const label = (opt?.label ?? "").trim();
			const value = (opt?.value ?? "").trim();
			if (!label || !value) continue;
			const out: DiscordSelectOption = {
				label: label.slice(0, DISCORD_SELECT_OPTION_LABEL_MAX),
				value,
			};
			const desc = (opt?.description ?? "").trim();
			if (desc) out.description = desc.slice(0, DISCORD_SELECT_OPTION_DESC_MAX);
			shaped.push(out);
		}
		if (shaped.length === 0) return null; // a string select with no usable option renders empty
		options = shaped;
	}

	const out: DiscordSelectSpec = { row: "select", kind: spec.kind, customId: prefixed };
	const placeholder = (spec.placeholder ?? "").trim();
	if (placeholder) out.placeholder = placeholder.slice(0, DISCORD_SELECT_PLACEHOLDER_MAX);
	if (typeof spec.minValues === "number" && Number.isFinite(spec.minValues)) out.minValues = spec.minValues;
	if (typeof spec.maxValues === "number" && Number.isFinite(spec.maxValues)) out.maxValues = spec.maxValues;
	if (options) out.options = options;
	return out;
}

/** One button spec before it's shaped + validated. */
export interface DiscordButtonInput {
	/** Button label shown to the user. */
	text: string;
	/** Opaque codec payload delivered to the handler on press. */
	value: string;
	/** Optional Discord button style. */
	style?: DiscordButtonStyleValue;
}

/**
 * Strip control bytes from a custom_id. The central codec already guarantees a
 * printable, short payload, so this is purely defensive for a value that didn't
 * come from the codec — and we never truncate a payload (we DROP an over-budget
 * one at the call site), since a truncated id would decode to the wrong action.
 */
export function sanitizeDiscordCustomId(value: string): string {
	// oxlint-disable-next-line no-control-regex
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Shape one button input into a validated spec, or null when it can't fit. */
function toButton(input: DiscordButtonInput): DiscordButtonSpec | null {
	const label = (input?.text ?? "").trim();
	const customId = sanitizeDiscordCustomId(input?.value ?? "");
	if (!label || !customId) return null;
	// Reject (don't truncate) an id that won't fit — a truncated payload would
	// decode to the wrong action on press.
	if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) return null;
	return {
		label: label.slice(0, DISCORD_BUTTON_LABEL_MAX),
		customId,
		style: input.style ?? DISCORD_BUTTON_STYLE.Secondary,
	};
}

/** Group a flat button list into rows of at most 5, capped at 5 rows total. */
function chunkIntoRows(buttons: DiscordButtonSpec[]): DiscordActionRow[] {
	const rows: DiscordActionRow[] = [];
	for (let i = 0; i < buttons.length && rows.length < DISCORD_MAX_ROWS; i += DISCORD_BUTTONS_PER_ROW) {
		rows.push(buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW));
	}
	return rows;
}

/**
 * Build the action rows for an APPROVAL prompt from the central codec's
 * `{ label, data, decision }` specs (the payload rides in `custom_id`). Returns
 * `[]` when fewer than two byte-safe buttons could be shaped — the caller then
 * falls back to a text prompt rather than ship a half-rendered prompt. `Deny` is
 * styled Danger; the first (allow-once) button Success.
 */
export function buildDiscordApprovalRows(
	specs: ReadonlyArray<{ label: string; data: string; decision?: string }>,
): DiscordActionRow[] {
	const buttons: DiscordButtonSpec[] = [];
	for (const s of specs) {
		const style: DiscordButtonStyleValue =
			s.decision === "deny"
				? DISCORD_BUTTON_STYLE.Danger
				: s.decision === "allow-once"
					? DISCORD_BUTTON_STYLE.Success
					: DISCORD_BUTTON_STYLE.Secondary;
		const btn = toButton({ text: s.label, value: s.data, style });
		if (btn) buttons.push(btn);
	}
	if (buttons.length < 2) return []; // not enough buttons → caller uses text prompt
	return chunkIntoRows(buttons);
}

/**
 * Build the action rows for a GENERAL button keyboard from a grid of specs. Each
 * spec's `data` is prefixed with {@link GENERAL_CALLBACK_PREFIX} + sanitized; a
 * button whose prefixed id exceeds the budget OR whose label is empty is
 * DROPPED. Returns `null` when no usable button remains (the caller then sends a
 * plain message instead). The grid is flattened + re-chunked into Discord's
 * 5-per-row / 5-row limits.
 */
export function buildDiscordButtonRows(grid: Array<Array<{ text: string; data: string }>>): DiscordActionRow[] | null {
	const buttons: DiscordButtonSpec[] = [];
	for (const row of grid) {
		for (const spec of row) {
			const label = (spec?.text ?? "").trim();
			const token = spec?.data ?? "";
			if (!label || !token) continue;
			const prefixed = `${GENERAL_CALLBACK_PREFIX}${token}`;
			const btn = toButton({ text: label, value: prefixed });
			if (btn) buttons.push(btn);
		}
	}
	if (buttons.length === 0) return null;
	return chunkIntoRows(buttons);
}

/* ───────────────────────── modal-trigger button (Fix 3b) ───────────────────────── */

/**
 * Register a modal definition + build the BUTTON that opens it. The button is a
 * normal component whose `custom_id` is a `modal:<modalId>` marker (NOT a general
 * token): on press the connection recognizes the marker and calls `showModal`
 * instead of routing a turn. Returns the button spec + the minted modal id (so a
 * caller can correlate). Returns `null` when the label is empty or the marker
 * overflows the custom_id budget (never the case for a short generated id, but
 * guarded for symmetry with the other builders).
 */
export function buildDiscordModalTriggerButton(params: {
	label: string;
	registration: DiscordModalRegistration;
	style?: DiscordButtonStyleValue;
}): { button: DiscordButtonSpec; modalId: string } | null {
	const label = (params?.label ?? "").trim();
	if (!label) return null;
	const modalId = registerDiscordModal(params.registration);
	const customId = buildDiscordModalCustomId(modalId);
	const btn = toButton({ text: label, value: customId, style: params.style ?? DISCORD_BUTTON_STYLE.Primary });
	if (!btn) return null;
	return { button: btn, modalId };
}
