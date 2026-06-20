/**
 * Brigade virtual-office layer — receiver-side hint render (Stage D).
 *
 * When a session-inbox event lands carrying `brigade-org-kind:<kind>:…`
 * metadata on its `contextKey`, the receiving turn gets a one-paragraph
 * ephemeral block describing WHO sent the message and WHY framing
 * (delegation / escalation / review). This is the receiver-side counterpart
 * to the `delegate_to_department` tool (Stage D):
 *
 *   - The sender writes a kind-tagged event into the receiver's inbox.
 *   - The receiver's turn peeks the inbox before draining, calls
 *     `renderReceiverHint(event)` on each pending event, and appends the
 *     returned string (when defined) to the per-turn ephemeral suffix.
 *
 * STAGE-D CONTRACT
 * ----------------
 *   - Returns `undefined` for any event whose contextKey does NOT decode
 *     to a `DeliveryKindMetadata`. Legacy events (no kind tag) pass
 *     through unchanged — the agent loop's existing `combinedPrefix`
 *     wiring is the only thing that renders them, and the new
 *     additive-gate adds nothing on top.
 *   - Block is one heading + 1-3 lines, NEVER more. The receiver-side
 *     budget mirrors the sender-side org block's discipline (≤15 lines
 *     for the static org section) — these run BELOW the cache boundary
 *     so they're cheap, but bloating the model with redundant context
 *     is still a regression.
 *
 * No external agent-codebase identifiers
 * are referenced from this file.
 */

import {
  decodeDeliveryKindContextKey,
  type DeliveryKind,
  type DeliveryKindMetadata,
} from "../../agents/org/delivery-kind.js";
import type { SystemEvent } from "../../agents/session-inbox.js";

/**
 * Shape of the inbound event the renderer needs. Accepts a subset of
 * `SystemEvent` so callers can pass either the full event or a stub
 * carrying just `text + contextKey`.
 */
export interface ReceiverHintEventLike {
  text?: string;
  contextKey?: string | null | undefined;
}

/**
 * Render a per-event ephemeral hint. Returns `undefined` when the event
 * is not kind-tagged (legacy or non-org event) so the caller can simply
 * skip it without additional conditional handling.
 *
 * The output is a single multi-line string:
 *
 *   ## New work from <sender.department>
 *   <Role-or-id> sent you this as <kind framing>.
 *
 * The optional `text` field is NOT echoed here — the formatted system-
 * event block (drained by `drainFormattedSessionEvents`) already carries
 * the message body. The hint exists only to FRAME that body so the model
 * picks the right verb on its reply.
 */
export function renderReceiverHint(
  event: ReceiverHintEventLike,
): string | undefined {
  const metadata = decodeDeliveryKindContextKey(event.contextKey);
  if (!metadata) return undefined;
  return renderHintFromMetadata(metadata);
}

/**
 * Internal: render directly from already-decoded metadata. Exposed
 * separately for unit tests that prefer to construct the metadata
 * inline rather than build a full event.
 */
export function renderReceiverHintFromMetadata(
  metadata: DeliveryKindMetadata,
): string {
  return renderHintFromMetadata(metadata);
}

function renderHintFromMetadata(metadata: DeliveryKindMetadata): string {
  const heading = buildHeading(metadata);
  const body = buildBody(metadata);
  return [heading, body].filter((line) => line.length > 0).join("\n");
}

function buildHeading(metadata: DeliveryKindMetadata): string {
  if (metadata.fromDepartment) {
    return `## New work from ${metadata.fromDepartment}`;
  }
  return `## New work from ${metadata.fromAgentId}`;
}

function buildBody(metadata: DeliveryKindMetadata): string {
  const sender = metadata.fromRole
    ? `${metadata.fromRole} (${metadata.fromAgentId})`
    : metadata.fromAgentId;
  return `${sender} sent you this as a ${framingFor(metadata.kind)}.`;
}

/**
 * Map the kind to a human-readable framing the model can act on. Stable
 * strings — tests pin them so prompt drift is caught.
 */
function framingFor(kind: DeliveryKind): string {
  switch (kind) {
    case "delegation":
      return "delegation (please own the work)";
    case "escalation":
      return "escalation (a downstream member needs your call)";
    case "review":
      return "review request (feedback only — do not execute)";
    default:
      // Defensive: future kinds fall through to a neutral framing rather
      // than throwing. The `DeliveryKind` union is closed today so this
      // branch is unreachable, but keeping it stable is cheap.
      return "message";
  }
}

/**
 * Convenience: drain-format the receiver hints for a list of events.
 * Returns `undefined` when no event in the batch carries kind metadata,
 * so the caller can omit the section entirely instead of emitting an
 * empty block.
 */
export function renderReceiverHints(
  events: readonly ReceiverHintEventLike[],
): string | undefined {
  if (events.length === 0) return undefined;
  const blocks: string[] = [];
  for (const event of events) {
    const block = renderReceiverHint(event);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}

// Re-export the SystemEvent type for callers that want stronger typing
// in tests / integration sites. Pure type re-export — no runtime cost.
export type { SystemEvent };
