/**
 * Shared convention for GENERAL (agent-attached) inline-button callbacks.
 *
 * Approval buttons carry codec payloads the central approval bridge consumes.
 * GENERAL buttons (attached by the agent via the `message_action` `buttons`
 * kind) carry an app-defined token namespaced with {@link GENERAL_CALLBACK_PREFIX}
 * so the inbound pipeline can tell the two apart: it tries the approval bridge
 * first, and a callback that didn't match an approval but DOES carry the general
 * prefix is routed through the pipeline as a synthetic turn instead of being
 * dropped.
 *
 * Channel-agnostic on purpose — both the Telegram keyboard builder (which mints
 * the prefixed `callback_data`) and the pipeline (which decodes it) import from
 * here so the prefix lives in ONE place.
 */

/** Namespace prefix marking a callback as a general (agent-attached) button. */
export const GENERAL_CALLBACK_PREFIX = "g:";

/** True when a raw `callback_data` value is a general (agent-attached) button. */
export function isGeneralCallbackData(data: string | undefined): boolean {
	return typeof data === "string" && data.startsWith(GENERAL_CALLBACK_PREFIX);
}

/**
 * Strip the general prefix, returning the app-defined token the agent set.
 * Returns "" when the input is not a general callback.
 */
export function decodeGeneralCallbackData(data: string | undefined): string {
	if (!isGeneralCallbackData(data)) return "";
	return (data as string).slice(GENERAL_CALLBACK_PREFIX.length);
}

/**
 * Build the synthesized turn text the agent sees when a GENERAL (agent-attached)
 * component is interacted with. A plain button yields `[button] <token>` exactly
 * as before (byte-identical), so existing button flows are unchanged. When the
 * press came from a SELECT menu the chosen value(s) are appended as
 * `Selected: <values>` so the agent can branch on the choice it offered.
 *
 * `values` are surfaced verbatim — the channel layer is responsible for any id
 * prefixing (e.g. Discord entity selects prefix `user:` / `role:` / `channel:` /
 * `mentionable:`), so the agent sees the same shape it would on the wire.
 */
export function buildGeneralCallbackTurnText(token: string, values?: ReadonlyArray<string>): string {
	const base = `[button] ${token}`;
	const chosen = (values ?? []).filter((v) => typeof v === "string" && v.length > 0);
	if (chosen.length === 0) return base;
	return `${base}\nSelected: ${chosen.join(", ")}`;
}
