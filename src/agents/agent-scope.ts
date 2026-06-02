/**
 * Resolve the default agent id from a Brigade config.
 *
 * Brand-scrubbed analogue of the upstream `src/agents/agent-scope.ts`. Used
 * by the 8-tier route resolver as the terminal fallback when no binding
 * tier matches the inbound, and by the channel manager when no agent is
 * explicitly named for an account.
 *
 * Resolution order:
 *   1. `cfg.defaults.agentId` (operator-pinned default)
 *   2. The first agent id listed in `cfg.agents` (any non-`defaults` key)
 *   3. Hardcoded `"main"`
 *
 * Empty / non-string inputs in any of the above fall through to the next
 * step; never throws.
 */

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import type { BrigadeConfig } from "../config/types.js";

export function resolveDefaultAgentId(cfg: BrigadeConfig | undefined | null): string {
	if (!cfg) return DEFAULT_AGENT_ID;
	const pinned = (cfg.defaults as { agentId?: unknown } | undefined)?.agentId;
	if (typeof pinned === "string" && pinned.trim().length > 0) {
		return pinned.trim();
	}
	const agents = cfg.agents;
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults") continue;
			if (key.trim().length === 0) continue;
			return key.trim();
		}
	}
	return DEFAULT_AGENT_ID;
}
