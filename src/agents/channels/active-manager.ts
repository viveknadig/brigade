/**
 * Process-wide channel-manager singleton accessor.
 *
 * The gateway boots exactly ONE `ChannelManager` instance at startup
 * (`server.ts` → `startChannels`) which owns every started adapter. Agent
 * tools that need to reach those adapters mid-turn — chiefly `send_message`,
 * but also future `react`, `poll`, `edit` actions — call
 * `getActiveChannelManager()` to find them.
 *
 * Following the same pattern as `cron/active-service.ts` (singleton mounted
 * at boot, accessor returns `null` when no gateway is running). Tools that
 * find a null accessor refuse politely so unit tests + standalone CLI
 * invocations get a clear error instead of a confusing exception.
 */

import type { ChannelManager } from "./manager.js";

let activeManager: ChannelManager | null = null;

/**
 * Mount the gateway's channel manager so process-wide tools can reach it.
 * Called by `server.ts` immediately after `startChannels` resolves so a
 * cron job firing during boot (rare but possible) can still dispatch.
 * Tests pass `null` in afterEach to clear leakage between cases.
 */
export function setActiveChannelManager(manager: ChannelManager | null): void {
	activeManager = manager;
}

/** Read the active channel manager. Returns `null` when none is mounted. */
export function getActiveChannelManager(): ChannelManager | null {
	return activeManager;
}
