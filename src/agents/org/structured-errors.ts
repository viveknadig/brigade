/**
 * Brigade virtual-office layer — structured A2A denial messages (Stage C).
 *
 * When `sessions_send` fails because the derived A2A policy
 * (`orgGraphAsA2APolicy`) returned `false` for `from → to`, the legacy
 * error is just `"agent <to> not in allowlist"`. With an org graph
 * available we can do much better:
 *
 *   - Explain WHY the edge was denied (cross-department, missing
 *     reportsTo, or simply not a member).
 *   - Suggest a concrete REMEDIATION verb: either
 *     `delegate_to_department({department: "<dept>", message})` when the
 *     target is a member of a known department, OR
 *     `escalate via <manager-id>` when the caller has a manager.
 *
 * STAGE-C CONTRACT
 * ----------------
 *   - Only invoked when `cfg.org` is present AND `cfg.org.a2a.mode ===
 *     "derived"` AND the legacy denial path has already produced an
 *     error. The legacy error message is the input; we WRAP it.
 *   - When the graph doesn't have a useful suggestion (caller or target
 *     not a member, no manager, etc.), we return the original message
 *     verbatim. The caller never sees a "less informative" error than
 *     they would have gotten without the org layer.
 *
 * No external agent-codebase
 * identifiers are referenced from this file.
 */

import type { OrgGraph } from "./types.js";

export interface BuildOrgDeniedMessageParams {
  /** Original (legacy) denial message — used as the fallback. */
  originalMessage: string;
  /** Caller's agent id. */
  fromAgentId: string;
  /** Target agent id. */
  toAgentId: string;
  /** Derived org graph used to compute the suggestion. */
  graph: OrgGraph;
}

/**
 * Wrap a legacy A2A denial with an org-aware suggestion. The return
 * value REPLACES `originalMessage` only when we have a concrete next
 * step to offer — otherwise the original is returned untouched so the
 * caller never loses signal.
 */
export function buildOrgDeniedMessage(params: BuildOrgDeniedMessageParams): string {
  const { originalMessage, fromAgentId, toAgentId, graph } = params;

  const callerMember = graph.members[fromAgentId];
  const targetMember = graph.members[toAgentId];

  // Build the derivation-chain prefix. Even when no suggestion is
  // available, callers benefit from the structured reason. We only
  // skip the prefix when neither side is in the graph (the org layer
  // has nothing to say about the edge in that case).
  const reasonPrefix = buildReasonPrefix({
    fromAgentId,
    toAgentId,
    callerMember,
    targetMember,
  });

  const suggestion = buildSuggestion({
    callerMember,
    targetMember,
    toAgentId,
    graph,
  });

  if (!reasonPrefix && !suggestion) return originalMessage;

  const parts: string[] = [originalMessage];
  if (reasonPrefix) parts.push(reasonPrefix);
  if (suggestion) parts.push(suggestion);
  return parts.join(" — ");
}

interface ReasonPrefixCtx {
  fromAgentId: string;
  toAgentId: string;
  callerMember: OrgGraph["members"][string] | undefined;
  targetMember: OrgGraph["members"][string] | undefined;
}

function buildReasonPrefix(ctx: ReasonPrefixCtx): string | null {
  if (!ctx.callerMember && !ctx.targetMember) return null;
  if (!ctx.callerMember) {
    return `caller ${JSON.stringify(ctx.fromAgentId)} is not a member of the org`;
  }
  if (!ctx.targetMember) {
    return `target ${JSON.stringify(ctx.toAgentId)} is not a member of the org`;
  }
  if (ctx.callerMember.department !== ctx.targetMember.department) {
    return `cross-department edge ${JSON.stringify(ctx.callerMember.department)} → ${JSON.stringify(
      ctx.targetMember.department,
    )} is closed by derivation rule (v)`;
  }
  return `no direct edge in the derived org graph`;
}

interface SuggestionCtx {
  callerMember: OrgGraph["members"][string] | undefined;
  targetMember: OrgGraph["members"][string] | undefined;
  toAgentId: string;
  graph: OrgGraph;
}

function buildSuggestion(ctx: SuggestionCtx): string | null {
  // If we know the target's department, the consolidated `org` tool's
  // `delegate` action is the highest-leverage suggestion (delegate
  // routes to the dept's canonical head via the derived graph).
  if (ctx.targetMember && ctx.targetMember.department) {
    const dept = ctx.targetMember.department;
    const escalateClause = ctx.callerMember?.reportsTo
      ? ` or escalate via ${ctx.callerMember.reportsTo}`
      : "";
    return `use org({action:"delegate", department: ${JSON.stringify(
      dept,
    )}, message})${escalateClause}`;
  }
  // No target department — fall back to escalation if the caller has a
  // manager. If neither suggestion is available, return null so the
  // caller falls through to the original message.
  if (ctx.callerMember?.reportsTo) {
    return `escalate via ${ctx.callerMember.reportsTo}`;
  }
  return null;
}
