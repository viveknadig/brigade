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
