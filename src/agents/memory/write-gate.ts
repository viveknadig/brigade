/**
 * The write-gate — Tideline's memory-poisoning guard (build Step 12).
 *
 * Fact text is attacker-influenceable: a tool result or a fetched document can
 * contain "the user prefers X" or "ignore the prior note about Y". If such text
 * were written as an authoritative fact — or allowed to SUPERSEDE an
 * owner-authored one — auto-recall would later surface it as ground truth and
 * the model would act on a stranger's words. This gate confines low-trust
 * sources so that can't happen, WITHOUT touching the trusted path: a write with
 * no `sourceType` (legacy / owner-authored) is never gated.
 *
 * Two rules, both scoped to UNTRUSTED sources only:
 *   1. Segment protection — may not author an authoritative segment
 *      (identity / preference / correction). Those encode the operator's
 *      self-model and must come from the operator. Descriptive segments
 *      (knowledge / context / project / relationship) are fine — a tool that
 *      fetched a fact is a legitimate contributor there.
 *   2. Supersede protection — may not supersede (overwrite) a TRUSTED,
 *      owner-authored fact. An untrusted source can revise its own untrusted
 *      facts, but never the operator's.
 *
 * `channel_message` is deliberately NOT untrusted here: channel facts carry a
 * channel origin and are isolated from owner recall by construction (origin
 * filter in `FactStore.search`), so a peer can't reach the owner's store to
 * poison it. The gate guards the authoritative store specifically against
 * external content ingested during a turn (tool output / retrieved document).
 *
 * Pure policy — no I/O. `FactStore.write` resolves the supersede targets and
 * calls {@link evaluateWriteGate}; this module just decides.
 */

import type { MemoryRecord, MemorySegment, MemorySourceType } from "./records.js";

/**
 * Sources that are NOT the operator speaking — content the model derived from
 * something other than a direct owner statement. Their text can't be trusted to
 * author or overwrite authoritative memory:
 *   - `tool_output` / `retrieved_document` — external content (a web page, an
 *     API result) that can carry "the user prefers X" / "ignore prior facts".
 *   - `compaction` — a context-window SUMMARY the model produced; lossy and
 *     model-authored, so it must not be able to overwrite what the owner
 *     actually said (per the build-plan write-gate spec).
 * Everything else (undefined/legacy, user_instruction, owner_message,
 * channel_message, extraction, dream) is trusted by this gate.
 */
const UNTRUSTED_SOURCES: ReadonlySet<MemorySourceType> = new Set<MemorySourceType>([
	"tool_output",
	"retrieved_document",
	"compaction",
]);

/**
 * Segments that encode the operator's authoritative self-model — Brigade's
 * equivalent of "procedural / instruction" memory (the plan's term): `preference`
 * is how the operator wants things done, `identity`/`correction` are who they are
 * and what they've explicitly corrected. Only a trusted source may author these;
 * an untrusted source is confined to descriptive segments (knowledge / context /
 * project / relationship). This rule is what satisfies the spec's "an untrusted
 * source can't write procedural records".
 */
const PROTECTED_SEGMENTS: ReadonlySet<MemorySegment> = new Set<MemorySegment>([
	"identity",
	"preference",
	"correction",
]);

/** True when the source is external content (not the operator). `undefined`
 *  (legacy / owner-authored) is always trusted. */
export function isUntrustedSource(source: MemorySourceType | undefined): boolean {
	return source !== undefined && UNTRUSTED_SOURCES.has(source);
}

/** A target is owner-authored / trusted when its source is anything but an
 *  untrusted one — including `undefined` (legacy facts predate source tagging
 *  and are assumed owner-authored). */
export function isTrustedTarget(source: MemorySourceType | undefined): boolean {
	return !isUntrustedSource(source);
}

export type WriteGateVerdict = { allow: true } | { allow: false; reason: string };

/** Thrown by `FactStore.write` when the gate blocks a write. Distinct type so
 *  callers (the write_memory tool, extraction sweeps) can recognise a poisoning
 *  block vs an unexpected failure. */
export class WriteGateError extends Error {
	readonly code = "write_gate_blocked";
	constructor(reason: string) {
		super(`memory write blocked: ${reason}`);
		this.name = "WriteGateError";
	}
}

/**
 * Decide whether a new fact may be written. `supersedeTargets` are the existing
 * records this write would archive (already resolved by the store — the gate
 * does no I/O). A trusted/legacy source short-circuits to `allow` immediately.
 */
export function evaluateWriteGate(args: {
	sourceType: MemorySourceType | undefined;
	segment: MemorySegment;
	supersedeTargets: ReadonlyArray<Pick<MemoryRecord, "memoryId" | "sourceType">>;
}): WriteGateVerdict {
	if (!isUntrustedSource(args.sourceType)) return { allow: true };

	// Rule 1 — segment protection.
	if (PROTECTED_SEGMENTS.has(args.segment)) {
		return {
			allow: false,
			reason: `a ${args.sourceType} source may not author a "${args.segment}" fact — authoritative segments (identity/preference/correction) are owner-only`,
		};
	}

	// Rule 2 — supersede protection.
	const owned = args.supersedeTargets.find((t) => isTrustedTarget(t.sourceType));
	if (owned) {
		return {
			allow: false,
			reason: `a ${args.sourceType} source may not supersede owner-authored memory (${owned.memoryId})`,
		};
	}

	return { allow: true };
}
