/**
 * Brigade virtual-office layer — delivery kind (Stage D).
 *
 * Cross-agent A2A messages can carry a "kind" tag that explains WHY the
 * inbound landed in the receiver's inbox:
 *
 *   - "delegation"  — a peer is handing a task off (the canonical
 *                     `delegate_to_department` verb).
 *   - "escalation"  — a downstream member is bubbling something up to
 *                     their manager / the top-of-org.
 *   - "review"      — a peer wants feedback / sign-off, NOT execution.
 *
 * The kind metadata rides on the session-inbox event's `contextKey` so
 * that:
 *   1. No new field is added to `SystemEvent` (additive-conditional —
 *      the existing shape is preserved bit-for-bit when cfg.org is
 *      absent).
 *   2. Legacy events (no kind tag) decode to `undefined`; the receiver
 *      hint renderer returns `undefined` for them; the assembler emits
 *      nothing extra; the legacy code path stays identical.
 *
 * Encoding shape (rendered as a single contextKey string):
 *
 *   brigade-org-kind:<kind>:from:<senderAgentId>[:role:<role>][:dept:<dept>]
 *
 * The encoder lowercases the kind + agent id; the decoder is permissive
 * about field order but strict about the leading sentinel prefix so the
 * legacy `a2a:from:<sender>` contextKey (Stage C and earlier) is never
 * mistaken for a kind-tagged event.
 *
 * STAGE-D CONTRACT
 * ----------------
 *   - This module never touches the inbox queue itself. Producers
 *     (the `delegate_to_department` tool) call `encodeDeliveryKindContextKey`
 *     and pass the result through to `enqueueSystemEvent`. Consumers
 *     (the receiver-hint / escalation-inbox renderers) call
 *     `decodeDeliveryKindContextKey` on `event.contextKey`. No other
 *     wiring needed.
 *
 * No external agent-codebase identifiers
 * are referenced from this file.
 */

/** The three delivery kinds Stage D ships. */
export type DeliveryKind = "delegation" | "escalation" | "review";

/** Allow-list of kinds for runtime validation. */
const DELIVERY_KINDS: ReadonlySet<DeliveryKind> = new Set([
  "delegation",
  "escalation",
  "review",
]);

/** Sentinel prefix every kind-tagged contextKey starts with. */
const CONTEXT_KEY_PREFIX = "brigade-org-kind:";

/**
 * Result of decoding a contextKey carrying delivery-kind metadata. All
 * fields except `kind` are best-effort — when absent the renderer falls
 * back to the agent id alone.
 */
export interface DeliveryKindMetadata {
  kind: DeliveryKind;
  /** Sender agent id (lowercased canonical form). */
  fromAgentId: string;
  /** Optional human role of the sender (e.g. "Head of Logistics"). */
  fromRole?: string;
  /** Optional sender's department slug. */
  fromDepartment?: string;
}

/**
 * Type guard for the `DeliveryKind` union. Centralised so consumers
 * downstream (renderer, tests, validation) share one source of truth.
 */
export function isDeliveryKind(value: unknown): value is DeliveryKind {
  return typeof value === "string" && DELIVERY_KINDS.has(value as DeliveryKind);
}

/**
 * Build the contextKey string a producer passes to `enqueueSystemEvent`
 * so the receiver-hint renderer can pick up the kind on the next turn.
 *
 * Fields beyond `kind` + `fromAgentId` are encoded only when supplied.
 * The encoder never throws; invalid kinds short-circuit to `undefined`
 * so a malformed caller doesn't poison the inbox with a half-tagged
 * contextKey (the legacy `a2a:from:<sender>` path takes over instead).
 */
export function encodeDeliveryKindContextKey(params: {
  kind: DeliveryKind;
  fromAgentId: string;
  fromRole?: string;
  fromDepartment?: string;
}): string | undefined {
  if (!isDeliveryKind(params.kind)) return undefined;
  const from = (params.fromAgentId ?? "").trim().toLowerCase();
  if (!from) return undefined;
  const parts: string[] = [
    CONTEXT_KEY_PREFIX + params.kind,
    `from:${from}`,
  ];
  const role = (params.fromRole ?? "").trim();
  if (role) parts.push(`role:${encodeURIComponent(role)}`);
  const dept = (params.fromDepartment ?? "").trim().toLowerCase();
  if (dept) parts.push(`dept:${encodeURIComponent(dept)}`);
  return parts.join(":");
}

/**
 * Decode a contextKey produced by `encodeDeliveryKindContextKey`.
 * Returns `undefined` for legacy / non-kind-tagged contextKeys so the
 * receiver-hint renderer can short-circuit to "no hint" without
 * additional branching at the call site.
 *
 * Permissive about ordering of the optional `role` / `dept` fields,
 * strict about the sentinel prefix.
 */
export function decodeDeliveryKindContextKey(
  contextKey: string | null | undefined,
): DeliveryKindMetadata | undefined {
  if (typeof contextKey !== "string") return undefined;
  if (!contextKey.startsWith(CONTEXT_KEY_PREFIX)) return undefined;
  const tail = contextKey.slice(CONTEXT_KEY_PREFIX.length);
  if (!tail) return undefined;

  // The kind is the FIRST segment after the prefix; subsequent segments
  // are `key:value` pairs. We tolerate the contextKey itself containing
  // colons inside encoded role/dept values (they were URI-encoded), so
  // splitting by `:` and walking left-to-right is safe.
  const segments = tail.split(":");
  const kindRaw = segments.shift();
  if (!isDeliveryKind(kindRaw)) return undefined;

  let fromAgentId: string | undefined;
  let fromRole: string | undefined;
  let fromDepartment: string | undefined;

  for (let i = 0; i < segments.length; i += 2) {
    const key = segments[i];
    const value = segments[i + 1];
    if (!key || value === undefined) break;
    if (key === "from") fromAgentId = value;
    else if (key === "role") {
      try {
        fromRole = decodeURIComponent(value);
      } catch {
        fromRole = value;
      }
    } else if (key === "dept") {
      try {
        fromDepartment = decodeURIComponent(value);
      } catch {
        fromDepartment = value;
      }
    }
  }

  if (!fromAgentId) return undefined;
  const out: DeliveryKindMetadata = {
    kind: kindRaw,
    fromAgentId,
  };
  if (fromRole) out.fromRole = fromRole;
  if (fromDepartment) out.fromDepartment = fromDepartment;
  return out;
}
