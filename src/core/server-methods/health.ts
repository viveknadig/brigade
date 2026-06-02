/**
 * `health` gateway method handler (Step 25).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/server-methods/health.ts`.
 * Returns a compact runtime snapshot — the same payload that powers
 * `brigade doctor` + `brigade status` + the live-status WebSocket event.
 *
 * Snapshot composition (lazy + cheap on the hot path):
 *
 *   - Brigade build version + protocol version (from `protocol/handshake.ts`)
 *   - Active session count (from Step 11's live-session registry)
 *   - Active sub-agent run count (from Step 10's subagent-registry)
 *   - Channel manager runtime snapshot (Step 16, if mounted)
 *
 * The handler accepts `{ probe?: boolean }` — when true, it forces a
 * channel-status probe; when false (default), it returns the cached
 * snapshot. Brigade's manager-side cache TTL is not yet wired; the field
 * is accepted for forward-parity and ignored today.
 */

import {
	countActiveLiveSessions,
	listLiveSessions,
} from "../../agents/session-registry.js";
import { snapshotSubagentRunsForTests } from "../../agents/subagent-registry.js";
import { PROTOCOL_VERSION } from "../../protocol/handshake.js";
import type { HealthResult } from "../../protocol/methods.js";

const BOOT_TIME_MS = Date.now();

export interface HealthHandlerDeps {
	/**
	 * Optional channel-runtime snapshot supplier. Brigade's gateway hands
	 * in the manager's `getRuntimeSnapshot` here; tests can pass a stub
	 * or omit it entirely.
	 */
	getChannelRuntime?: () =>
		| Record<string, { state?: string }>
		| undefined;
	/** Brigade build version. Defaults to "dev" if not supplied. */
	getBrigadeVersion?: () => string;
}

export async function handleHealthMethod(
	params: { probe?: boolean } | undefined,
	deps: HealthHandlerDeps = {},
): Promise<HealthResult> {
	void params?.probe; // accepted for forward-parity; not used yet
	const channels = deps.getChannelRuntime?.();
	const activeSessions = countActiveLiveSessions();
	const liveSessions = listLiveSessions();
	const runs = snapshotSubagentRunsForTests();
	const activeRuns = runs.filter((r) => r.endedAt == null).length;
	return {
		status: deriveStatus(activeSessions, activeRuns),
		uptimeMs: Date.now() - BOOT_TIME_MS,
		versions: {
			brigade: deps.getBrigadeVersion?.() ?? "dev",
			protocol: PROTOCOL_VERSION,
		},
		...(channels ? { channels } : {}),
		...({
			liveSessions: liveSessions.length,
			activeSessions,
			activeSubagentRuns: activeRuns,
		} as Record<string, unknown>),
	};
}

function deriveStatus(activeSessions: number, activeRuns: number): HealthResult["status"] {
	if (activeSessions < 0 || activeRuns < 0) return "unavailable";
	return "ok";
}
