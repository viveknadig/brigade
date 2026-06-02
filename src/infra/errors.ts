/**
 * Shared error utilities used across the gateway, lane engine, and tools.
 *
 * Two named errors carry semantic weight beyond their message:
 *
 *   - `CommandLaneClearedError` — thrown by the lane engine when a queued
 *     work item is dropped because `clearCommandLane(lane)` (or
 *     `resetAllLanes()`) ran while it was waiting. Callers that see this
 *     should NOT retry — the lane was reset on purpose (gateway shutdown,
 *     test cleanup).
 *
 *   - `GatewayDrainingError` — thrown when the gateway is shutting down
 *     and refuses to accept new work. Callers should treat this as a
 *     normal stop signal, not a runtime failure.
 *
 * Both inherit from `Error` and set a stable `.name` so handlers can
 * `err.name === "CommandLaneClearedError"` match without instanceof
 * (instanceof breaks across module-cache boundaries in some test setups).
 */

export class CommandLaneClearedError extends Error {
	override readonly name = "CommandLaneClearedError";
	constructor(message = "command lane cleared") {
		super(message);
	}
}

export class GatewayDrainingError extends Error {
	override readonly name = "GatewayDrainingError";
	constructor(message = "gateway is draining; refusing new work") {
		super(message);
	}
}

/**
 * Format any thrown value (Error, string, plain object, undefined) into a
 * short single-line operator-facing string. Strips stack traces — callers
 * who want a stack should log `err` separately. Used everywhere we need to
 * surface a tool error / gateway error to the model or the TUI.
 */
export function formatErrorMessage(err: unknown): string {
	if (err === null || err === undefined) return "(no error)";
	if (err instanceof Error) {
		const msg = err.message.trim();
		return msg.length > 0 ? msg : err.name;
	}
	if (typeof err === "string") return err.trim() || "(empty error)";
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}
