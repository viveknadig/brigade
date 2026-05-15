/**
 * Sensitive-stop-reason classifier.
 *
 * Pi-level helper that recognises stop reasons indicating the model
 * declined to produce a normal reply — refusal, content filter, policy
 * block — and returns a friendly explanation the UI can render.
 *
 * Why this lives in `agents/` (Phase 5d migration): keeping it here
 * lets the TUI render layer import a Brigade-native module instead of
 * the legacy `core/agent.ts` aggregate. The behaviour is identical to
 * the prior `core/agent.ts:798` export it replaces; the only change
 * is the import path.
 */

export interface SensitiveStopReason {
	/** Short kind tag — useful for telemetry. */
	kind: "refusal" | "content_filter" | "policy" | "unknown_sensitive";
	/** User-facing explanation. Already friendly — caller can display as-is. */
	userMessage: string;
}

/**
 * Recognise stop reasons that indicate the model declined to produce a
 * normal reply (refusal, content filter, policy block). Returns null for
 * normal/expected stop reasons like `stop`, `end_turn`, `toolUse`, and
 * for stop reasons already handled elsewhere (`error`, `aborted`).
 *
 * Why this exists: when Anthropic returns `stop_reason: refusal` (etc),
 * the assistant message has no text content. Without this classifier the
 * UI just shows nothing and the user is confused. With it, we display a
 * clear message like "The model declined this request."
 *
 * Expressed as a post-hoc classifier on the final assistant message rather
 * than a stream wrapper — the outcome is the same and the integration
 * point is simpler.
 */
export function classifySensitiveStopReason(
	message: { stopReason?: string } | undefined | null,
): SensitiveStopReason | null {
	if (!message) return null;
	const reason = message.stopReason;
	if (!reason || typeof reason !== "string") return null;

	const r = reason.toLowerCase();

	// "Refusal" — model declined to respond. Anthropic's most common case.
	if (r === "refusal" || r === "refused") {
		return {
			kind: "refusal",
			userMessage:
				"The model declined this request. Try rephrasing or asking a different question.",
		};
	}

	// Content-policy variants across providers.
	if (
		r === "content_filter" ||
		r === "content_filtered" ||
		r === "safety" ||
		r === "policy_violation"
	) {
		return {
			kind: "content_filter",
			userMessage:
				"The model's content filter blocked this response. Try rephrasing the request.",
		};
	}

	// Unknown but suspicious — anything that ends in "_filter", "_block", "policy", "safety".
	if (/(_filter|_block|policy|safety|prohibited)/i.test(r)) {
		return {
			kind: "unknown_sensitive",
			userMessage: `The model stopped with an unrecognized policy reason ("${reason}"). Try rephrasing.`,
		};
	}

	// Normal stop reasons + already-handled cases — not our concern.
	return null;
}
