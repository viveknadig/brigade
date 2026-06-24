/**
 * In-memory registry of pending Discord modal (form) definitions (Fix 3b).
 *
 * A Discord modal carries up to five text-input fields, each with a label,
 * style, placeholder, and required flag. A modal is OPENED by pressing a
 * "modal-trigger" button; on submit Discord delivers the field values keyed by
 * each field's custom_id. The full field definition is far larger than the
 * 100-char `custom_id` budget a button/modal can carry, so it CANNOT ride inline
 * — hence this small side registry. The trigger button + the modal both carry
 * only a short `modal:<modalId>` marker; the heavy definition lives here, keyed
 * by that id.
 *
 * Entries expire after {@link MODAL_ENTRY_TTL_MS} so a never-submitted form
 * doesn't leak. `consume` removes the entry (a modal is single-use by default);
 * `get` peeks without removing (for the trigger → showModal lookup). A
 * reset hook is exported for tests.
 *
 * Pure module-level state — no I/O.
 */

/** A modal lives for 30 minutes before it's reaped (the form was abandoned). */
export const MODAL_ENTRY_TTL_MS = 30 * 60 * 1_000;

/** Discord supports at most 5 inputs per modal. */
export const DISCORD_MODAL_FIELD_MAX = 5;

/** discord.js `TextInputStyle` values (Short = single line, Paragraph = multi-line). */
export const DISCORD_TEXT_INPUT_STYLE = {
	short: 1,
	paragraph: 2,
} as const;

/** A single text-input field definition for a modal. */
export interface DiscordModalField {
	/** Field custom_id — Discord echoes this back keying the submitted value. */
	id: string;
	/** Label shown above the input. */
	label: string;
	/** `short` (single line) or `paragraph` (multi-line). Defaults to `short`. */
	style?: "short" | "paragraph";
	/** Whether the field must be filled before submit (default true). */
	required?: boolean;
	/** Placeholder hint shown in the empty input. */
	placeholder?: string;
}

/** A registered modal definition (the heavy form spec the custom_id can't carry). */
export interface DiscordModalEntry {
	/** Modal heading shown above the form. */
	title: string;
	/** Text-input fields (1..5). */
	fields: DiscordModalField[];
	/** Session the form belongs to (so a submit routes back to the right turn). */
	sessionKey?: string;
	/** Agent that attached the form. */
	agentId?: string;
	/** Account namespace. */
	accountId?: string;
	/** Optional allowlist of user ids permitted to submit. */
	allowedUsers?: string[];
	/** Epoch ms the entry was registered. */
	createdAt: number;
	/** Epoch ms the entry expires. */
	expiresAt: number;
}

/** What a caller supplies when registering a modal (timestamps are filled in). */
export interface DiscordModalRegistration {
	/** Modal heading (defaults to "Form" when empty). */
	title?: string;
	fields: DiscordModalField[];
	sessionKey?: string;
	agentId?: string;
	accountId?: string;
	allowedUsers?: string[];
}

/** modalId → entry. Insertion-ordered; pruned lazily on access. */
const registry = new Map<string, DiscordModalEntry>();

/** Monotonic counter feeding the generated modal ids (collision-free per process). */
let modalSeq = 0;

/** A clock seam so tests can drive expiry deterministically. */
let nowFn: () => number = () => Date.now();

/** Mint a short, unique modal id (fits the `modal:<id>` marker budget). */
export function nextDiscordModalId(): string {
	modalSeq += 1;
	return `m${modalSeq.toString(36)}${nowFn().toString(36).slice(-4)}`;
}

/** Drop every entry whose `expiresAt` is in the past. */
function pruneExpired(): void {
	const now = nowFn();
	for (const [id, entry] of registry) {
		if (entry.expiresAt <= now) registry.delete(id);
	}
}

/**
 * Register a modal definition, returning the modal id the trigger button carries.
 * The entry expires after {@link MODAL_ENTRY_TTL_MS}. Fields beyond the Discord
 * 5-input cap are dropped.
 */
export function registerDiscordModal(reg: DiscordModalRegistration): string {
	pruneExpired();
	const id = nextDiscordModalId();
	const now = nowFn();
	const fields = (reg.fields ?? []).slice(0, DISCORD_MODAL_FIELD_MAX);
	const entry: DiscordModalEntry = {
		title: (reg.title ?? "").trim() || "Form",
		fields,
		createdAt: now,
		expiresAt: now + MODAL_ENTRY_TTL_MS,
	};
	if (reg.sessionKey !== undefined) entry.sessionKey = reg.sessionKey;
	if (reg.agentId !== undefined) entry.agentId = reg.agentId;
	if (reg.accountId !== undefined) entry.accountId = reg.accountId;
	if (reg.allowedUsers !== undefined) entry.allowedUsers = reg.allowedUsers;
	registry.set(id, entry);
	return id;
}

/** Peek at a registered modal WITHOUT removing it (the trigger → showModal lookup). */
export function getDiscordModal(modalId: string): DiscordModalEntry | undefined {
	pruneExpired();
	const entry = registry.get(modalId);
	if (!entry) return undefined;
	if (entry.expiresAt <= nowFn()) {
		registry.delete(modalId);
		return undefined;
	}
	return entry;
}

/**
 * Consume a registered modal — return it AND remove it (a modal is single-use, so
 * a second submit of the same id degrades gracefully to `undefined`). Returns
 * `undefined` for a missing / expired id.
 */
export function consumeDiscordModal(modalId: string): DiscordModalEntry | undefined {
	const entry = getDiscordModal(modalId);
	if (entry) registry.delete(modalId);
	return entry;
}

/** TEST-ONLY: clear the registry + reset the clock + id counter. */
export function __resetDiscordModalRegistryForTest(clock?: () => number): void {
	registry.clear();
	modalSeq = 0;
	nowFn = clock ?? (() => Date.now());
}
