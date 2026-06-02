/**
 * Channel-id helpers shared by routing, delivery, session-context, and the
 * sessions_* tools. Centralises the "what channels exist + which ones can
 * actually receive an outbound message" question so every subsystem agrees.
 *
 * Two categories:
 *
 *   1. **Gateway-internal channels** — `tui`, `cron`, `hook`, `internal`,
 *      `node`. These carry routing semantics but are NOT real messaging
 *      surfaces (you cannot send a WhatsApp DM to "tui"). They identify
 *      origin / scheduler / hook-injection paths.
 *
 *   2. **Deliverable channels** — `whatsapp`, `slack`, `discord`,
 *      `telegram`, `imessage`, `signal`, `sms`, `matrix`, `teams`,
 *      `webchat`, `email`. These map to a started ChannelAdapter that
 *      can actually fan out a message to a peer.
 *
 * The split matters at three places:
 *   - `send_message` tool's channel param enum
 *   - `cron` job's `delivery.channel` validation
 *   - `sessions_send` cross-session messaging (always uses
 *     `INTERNAL_MESSAGE_CHANNEL` because the target session's gateway
 *     decides the actual surface).
 *
 * `GatewayMessageChannel` is intentionally a string type (not a literal
 * union) because channel ids are extension-defined — a new adapter
 * registers its id at boot; the runtime can't enumerate them at
 * compile-time. The helper predicates below check membership against the
 * canonical sets at runtime.
 */

/** Synthetic channel id used for cross-session messaging that doesn't go
 *  through a real adapter (peer→peer A2A flow, system-event injection). */
export const INTERNAL_MESSAGE_CHANNEL = "internal" as const;

/** Set of channel ids that route INTO the runtime (origin signal) but
 *  don't have an outbound adapter. */
const GATEWAY_INTERNAL = new Set<string>([
	"tui",
	"cron",
	"hook",
	"internal",
	"node",
]);

/** Set of channel ids that map to real adapters with outbound surfaces.
 *  Extension-registered adapters add to this at runtime via
 *  `registerDeliverableChannel(id)` — kept defensive so legacy code that
 *  hardcodes a channel id still validates. */
const DELIVERABLE: Set<string> = new Set([
	"whatsapp",
	"slack",
	"discord",
	"telegram",
	"imessage",
	"signal",
	"sms",
	"matrix",
	"teams",
	"webchat",
	"email",
]);

/** The channel id type used throughout routing + delivery. */
export type GatewayMessageChannel = string;

/**
 * Trim + lowercase a free-form input into a canonical channel id.
 * Returns `undefined` when the input is missing / empty / non-string.
 */
export function normalizeMessageChannel(value: unknown): GatewayMessageChannel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** True when the channel is a gateway-internal routing label (no adapter). */
export function isGatewayMessageChannel(channel: string | undefined): boolean {
	if (!channel) return false;
	return GATEWAY_INTERNAL.has(channel.trim().toLowerCase());
}

/** True when the channel has an outbound adapter (real send surface). */
export function isDeliverableMessageChannel(channel: string | undefined): boolean {
	if (!channel) return false;
	return DELIVERABLE.has(channel.trim().toLowerCase());
}

/**
 * Extension-time hook for an adapter to declare its channel id as
 * deliverable. Called from each `ChannelAdapter`'s start path so the
 * `isDeliverableMessageChannel` predicate stays accurate for runtime-
 * registered channels (e.g. a custom adapter shipped via a plugin).
 *
 * Idempotent — safe to call multiple times for the same channel.
 */
export function registerDeliverableChannel(channel: string): void {
	const normalized = normalizeMessageChannel(channel);
	if (normalized) DELIVERABLE.add(normalized);
}

/**
 * List every deliverable channel id known to the runtime. Used by the
 * `## Messaging` system-prompt section + the `send_message` tool's enum.
 * Stable ordering: sorted alphabetically for prompt-cache stability.
 */
export function listDeliverableMessageChannels(): readonly string[] {
	return [...DELIVERABLE].sort();
}
