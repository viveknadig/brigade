/**
 * Signal that an inbound-handling attempt failed in a way that the channel
 * SHOULD retry on natural redelivery (e.g. Slack retries on missed ACKs;
 * Teams marks unread until acked; Email-bot polls the next mailbox cycle).
 *
 * Wrap a transient inner error in this class to ask the channel manager NOT to
 * commit the inbound dedupe — releasing it instead so the platform's
 * re-delivery on the next reconnect / poll gets a fresh attempt. Without this,
 * a single network blip during the agent turn would consume the message
 * forever and the user would have to manually re-send.
 *
 * Wraps the underlying error as `.cause` so the error classifier still walks
 * down to the real reason (e.g. `rate_limit` / `timeout` / `billing`) and the
 * recipient sees the appropriate friendly message even if we end up replying
 * instead of releasing.
 *
 * **WhatsApp note:** Baileys ACKs at the protocol level the moment a `notify`
 * arrives, so the WhatsApp server will NOT redeliver the same `msg.key.id`
 * even if we release our dedupe. The WhatsApp adapter therefore does not wire
 * this through today. It's wired through dedupe.ts so non-Baileys channels
 * (Slack/Teams/IMAP/etc.) can opt in without rework.
 */
export class ChannelRetryableInboundError extends Error {
	readonly retryable = true as const;

	constructor(message: string, opts?: { cause?: unknown }) {
		super(message, opts?.cause instanceof Error ? { cause: opts.cause } : undefined);
		this.name = "ChannelRetryableInboundError";
	}
}

/** Type predicate — `true` for any error explicitly marked retryable for channels. */
export function isChannelRetryableInboundError(value: unknown): value is ChannelRetryableInboundError {
	if (!value || typeof value !== "object") return false;
	const v = value as { name?: unknown; retryable?: unknown };
	return v.name === "ChannelRetryableInboundError" && v.retryable === true;
}
