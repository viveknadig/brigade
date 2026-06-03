/**
 * SessionInbox → prompt-block orchestrator (Step 12).
 *
 * Sits one layer above `session-inbox.ts` (Step 11). Decides:
 *
 *   - WHEN to drain (turn-start; never mid-stream — events arriving while
 *     the model is generating tokens queue and wait for the next turn
 *     boundary).
 *   - HOW to compose drained events into prompt text (`System: [ts] text`
 *     per line, `System (untrusted): ...` for tainted events).
 *   - WHICH events to filter (heartbeat scheduler noise, node-PII suffix
 *     scrubbing) — at format time, NOT at enqueue time. Events stay in
 *     the queue even if they'll be filtered, so consumers can audit what
 *     was suppressed by `peek`-ing first.
 *
 * Brand-scrubbed analogue of upstream's `src/auto-reply/reply/session-system-events.ts`
 * — the `drainFormattedSystemEvents` flow, scoped to the slice Brigade
 * needs without the upstream's channel-summary prepend (no channel
 * surface yet) or the upstream `Config`-driven timezone
 * resolution (Brigade uses UTC ISO-8601 today; callers can override).
 *
 * Naming note: Brigade already has `agents/pending-system-events.ts`,
 * which is the cron-only announce queue (Track 2 — see that file's
 * doc-comment). The orchestrator here works against the broader
 * SessionInbox queue from Step 11 and is reference-source-equivalent. The two
 * queues serve different paths and are NOT consolidated until the
 * Step 25 dispatcher arrives.
 *
 * Two entry points:
 *
 *   - `drainFormattedSessionEvents({ sessionKey, ... })` — drains + formats
 *     in one call. Used by the turn-start path: when a real inbound
 *     arrives, the prompt assembler calls this once and prepends the
 *     returned block (if any) to the user message body.
 *
 *   - `peekFormattedSessionEvents({ sessionKey })` — read-only inspect
 *     (no drain). Used by the heartbeat preflight: peek first, decide
 *     whether to fire a heartbeat turn, only then `consume` the
 *     inspected prefix so events stay queued for the next real turn if
 *     the heartbeat is filtered out.
 *
 * Output format (one line per event sub-line):
 *
 *   `System: [2026-06-02T14:23:45Z] Build #42 complete`
 *   `System (untrusted): [2026-06-02T14:23:50Z] alert: CPU > 90%`
 *
 * If every queued event is filtered, returns `undefined` so the caller
 * can omit the block entirely (no empty "System: " line in the prompt).
 *
 * Filter rules (lifted verbatim from the upstream noise-suppression):
 *
 *   - drop lines containing `reason periodic`  (heartbeat-scheduler noise)
 *   - drop lines starting with `read heartbeat.md`  (heartbeat prompt itself)
 *   - drop lines containing `heartbeat poll` or `heartbeat wake`
 *   - scrub the `Node: ... · last input X · Y` suffix (avoids PII echo)
 *
 * Filtering happens at compose time so an audit can `peek` to see what
 * was queued including noise; the noise just doesn't make it to the
 * prompt.
 */

import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
	drainSystemEventEntries,
	peekSystemEventEntries,
	type SystemEvent,
} from "./session-inbox.js";

const NODE_LAST_INPUT_SUFFIX_RE = / · last input [^·]+/i;

/**
 * Apply upstream's heartbeat-noise filter + node-PII scrub.
 * Returns the compacted text or `null` if the line should be dropped.
 */
function compactSystemEventText(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	// Heartbeat scheduler noise — never useful to the model.
	if (lower.includes("reason periodic")) return null;
	// The heartbeat prompt itself. Cron payloads that *mention* heartbeat
	// won't match this prefix.
	if (lower.startsWith("read heartbeat.md")) return null;
	// Heartbeat poll/wake completion noise.
	if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) return null;
	// `Node:` status lines leak the last input path. Scrub the suffix.
	if (trimmed.startsWith("Node:")) {
		return trimmed.replace(NODE_LAST_INPUT_SUFFIX_RE, "").trim();
	}
	return trimmed;
}

/**
 * Default timestamp formatter: ISO 8601 in UTC, second resolution.
 * Consumers that need local-time formatting can pass their own `formatTimestamp`.
 */
function defaultFormatTimestamp(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function eventPrefix(event: SystemEvent): string {
	return event.trusted === false ? "System (untrusted)" : "System";
}

/**
 * Format a single event into one or more prompt lines (one per text
 * line in the event). The first line carries the `[timestamp]`; any
 * continuation lines carry just the prefix so the model can't mistake
 * a continuation for fresh user content.
 */
function formatEventLines(
	event: SystemEvent,
	formatTimestamp: (ts: number) => string,
): string[] {
	const compacted = compactSystemEventText(event.text);
	if (!compacted) return [];
	const prefix = eventPrefix(event);
	const timestamp = formatTimestamp(event.ts);
	const timestampLabel = timestamp ? `[${timestamp}] ` : "";
	const sublines = compacted.split("\n");
	return sublines.map((subline, index) =>
		index === 0 ? `${prefix}: ${timestampLabel}${subline}` : `${prefix}: ${subline}`,
	);
}

export interface FormatSessionEventsOptions {
	/**
	 * Override the default ISO-8601 formatter. Receives ms-since-epoch,
	 * should return a short human-readable timestamp (or empty string to
	 * omit it).
	 */
	formatTimestamp?: (ts: number) => string;
}

/**
 * Format a `SystemEvent[]` list to a single prompt block (or `undefined`
 * if every event was filtered out). Pure — does not touch the inbox.
 */
export function formatSessionEventBlock(
	events: readonly SystemEvent[],
	opts: FormatSessionEventsOptions = {},
): string | undefined {
	if (events.length === 0) return undefined;
	const formatTimestamp = opts.formatTimestamp ?? defaultFormatTimestamp;
	const lines: string[] = [];
	for (const event of events) {
		for (const formatted of formatEventLines(event, formatTimestamp)) {
			lines.push(formatted);
		}
	}
	return lines.length === 0 ? undefined : lines.join("\n");
}

export interface DrainFormattedSessionEventsParams extends FormatSessionEventsOptions {
	sessionKey: string;
	/** Reserved for future channel-summary prepend (no-op today). */
	isMainSession?: boolean;
	/** Reserved for future channel-summary prepend (no-op today). */
	isNewSession?: boolean;
}

/**
 * Drain every queued event for a session and return the formatted prompt
 * block (or `undefined` if no event survived the filter). The session's
 * inbox is empty after this call.
 *
 * `isMainSession` + `isNewSession` are accepted for upstream-parity but
 * not yet used — when Brigade lands per-channel status summaries, those
 * will prepend a "Channel status:" block on the first turn of a fresh
 * main session.
 */
export function drainFormattedSessionEvents(
	params: DrainFormattedSessionEventsParams,
): string | undefined {
	const events = drainSystemEventEntries(params.sessionKey);
	return formatSessionEventBlock(events, { formatTimestamp: params.formatTimestamp });
}

export interface PeekFormattedSessionEventsParams extends FormatSessionEventsOptions {
	sessionKey: string;
}

/**
 * Peek (NO drain). Same composition as `drainFormattedSessionEvents`, but
 * leaves the inbox intact. Used by the heartbeat preflight to decide
 * whether to fire a turn; the actual drain only happens later (via
 * `consumeSystemEventEntries`) if the heartbeat run is going to proceed.
 *
 * Returns `undefined` when every event would be filtered — the peek
 * answer is "no surface-able events" even if the queue technically
 * contains noise.
 */
export function peekFormattedSessionEvents(
	params: PeekFormattedSessionEventsParams,
): string | undefined {
	const events = peekSystemEventEntries(params.sessionKey);
	return formatSessionEventBlock(events, { formatTimestamp: params.formatTimestamp });
}

/**
 * Inspect the pending events for a session without formatting.
 *
 * Returns the array of `SystemEvent` objects (cloned, safe to mutate)
 * plus two derived flags:
 *   - `hasSurfaceable` — `true` iff at least one event would survive the
 *     filter pipeline; used by the heartbeat preflight to decide whether
 *     to fire a turn at all.
 *   - `hasUntrusted` — `true` iff any event carries `trusted: false`;
 *     used to force `senderIsOwner: false` on the resulting turn so the
 *     model treats the context as third-party.
 */
export function inspectPendingSessionEvents(sessionKey: string): {
	events: SystemEvent[];
	hasSurfaceable: boolean;
	hasUntrusted: boolean;
} {
	const events = peekSystemEventEntries(sessionKey);
	const hasUntrusted = events.some((event) => event.trusted === false);
	const hasSurfaceable = events.some((event) => compactSystemEventText(event.text) !== null);
	return { events, hasSurfaceable, hasUntrusted };
}
