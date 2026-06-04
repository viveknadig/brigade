/**
 * Brigade virtual-office layer — top-of-org escalation inbox (Stage D).
 *
 * When the agent receiving the turn is the `topOrder` AND the session
 * inbox has pending events tagged with `kind === "escalation"`, the
 * assembler emits an additional `## Escalation Inbox` block listing
 * each escalation by sender + role. This is purely an attention-shaping
 * surface — the events themselves still flow through the existing
 * formatted-events block (drained by `drainFormattedSessionEvents`), so
 * the legacy code path is preserved bit-for-bit.
 *
 * STAGE-D CONTRACT
 * ----------------
 *   - Returns `undefined` when:
 *       - `callerAgentId !== graph.topOrder` (this section only fires
 *         for the top-of-org caller — non-top callers see only the
 *         per-event receiver-hint blocks).
 *       - No event in the batch carries `kind === "escalation"`.
 *   - Block is at most `1 heading + 8 lines`. Older escalations beyond
 *     the cap get a "+N more" tail — the receiver-hint section already
 *     lists every event individually so the inbox is a summary view.
 *
 * No openclaw / clawd / hermes / boop / paperclip / nanoclaw identifiers
 * are referenced from this file.
 */

import {
  decodeDeliveryKindContextKey,
  type DeliveryKindMetadata,
} from "../../agents/org/delivery-kind.js";
import type { OrgGraph } from "../../agents/org/types.js";
import type { SystemEvent } from "../../agents/session-inbox.js";

/** Max escalations listed before the "+N more" tail kicks in. */
export const ESCALATION_INBOX_LIST_CAP = 5;

/**
 * Subset of `SystemEvent` the escalation-inbox renderer needs. Callers
 * can pass the full event (the agent loop does); tests can construct
 * minimal stubs without the full inbox shape.
 */
export interface EscalationInboxEventLike {
  text?: string;
  contextKey?: string | null | undefined;
}

export interface RenderEscalationInboxParams {
  /** The agent receiving the turn. */
  callerAgentId: string;
  /** Derived org graph (from `deriveOrgGraph(cfg)`). */
  graph: OrgGraph | undefined;
  /** Inbox events the caller's turn is about to process. */
  events: readonly EscalationInboxEventLike[];
}

/**
 * Render the `## Escalation Inbox` block. Returns `undefined` when the
 * caller is NOT the top-of-org OR no event is tagged as an escalation.
 */
export function renderEscalationInbox(
  params: RenderEscalationInboxParams,
): string | undefined {
  if (!params.graph) return undefined;
  if (params.callerAgentId !== params.graph.topOrder) return undefined;
  if (params.events.length === 0) return undefined;

  const escalations: DeliveryKindMetadata[] = [];
  for (const event of params.events) {
    const metadata = decodeDeliveryKindContextKey(event.contextKey);
    if (!metadata) continue;
    if (metadata.kind !== "escalation") continue;
    escalations.push(metadata);
  }
  if (escalations.length === 0) return undefined;

  const lines: string[] = ["## Escalation Inbox"];
  const shown = escalations.slice(0, ESCALATION_INBOX_LIST_CAP);
  for (const metadata of shown) {
    lines.push(renderOne(metadata));
  }
  const overflow = escalations.length - shown.length;
  if (overflow > 0) {
    lines.push(`(+${overflow} more escalation${overflow === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

function renderOne(metadata: DeliveryKindMetadata): string {
  const sender = metadata.fromRole
    ? `${metadata.fromRole} (${metadata.fromAgentId})`
    : metadata.fromAgentId;
  if (metadata.fromDepartment) {
    return `- ${sender} from ${metadata.fromDepartment}`;
  }
  return `- ${sender}`;
}

// Re-export SystemEvent so callers can keep their imports consolidated.
export type { SystemEvent };
