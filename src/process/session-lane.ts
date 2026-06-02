/**
 * Per-session command lane resolvers.
 *
 * Brand-scrubbed analogue of the upstream `src/agents/pi-embedded-runner/lanes.ts`.
 * The functions are pure string mappers used by the gateway dispatcher,
 * the embedded runner, and the cron scheduler to translate a raw key
 * (sessionKey or lane name) into the canonical lane id that the FIFO
 * engine in `./command-queue.ts` keys on.
 *
 * Three mappers, one rule each:
 *
 *   - `resolveSessionLane(key)` → `session:<key>` for channel/session-scoped
 *      lanes (per-peer isolation across WhatsApp DMs, Slack channels, etc.).
 *      Empty / whitespace-only keys fall back to the well-known `Main` lane
 *      so an unsourced inbound never collides with a sibling session.
 *
 *   - `resolveGlobalLane(lane?)` → one of the well-known lane ids on
 *      `CommandLane`. Special-cases `Cron`: a cron task already holds the
 *      `Cron` lane slot, so any operation enqueued from inside that turn
 *      MUST go to `Nested` to avoid self-deadlock.
 *
 *   - `resolveEmbeddedSessionLane(key)` → identical to `resolveSessionLane`
 *      today; kept as a separate symbol so the embedded-runner call site
 *      stays explicit about which side of the split it's running on. If
 *      the two ever diverge (e.g. embedded gets its own pool), this is the
 *      single place to fork.
 */

import { CommandLane } from "./lanes.js";

export function resolveSessionLane(key: string): string {
	const cleaned = key.trim() || CommandLane.Main;
	return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string): string {
	const cleaned = lane?.trim();
	// Cron jobs hold the cron lane slot; inner operations must use nested to
	// avoid deadlock.
	if (cleaned === CommandLane.Cron) {
		return CommandLane.Nested;
	}
	return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string): string {
	return resolveSessionLane(key);
}
