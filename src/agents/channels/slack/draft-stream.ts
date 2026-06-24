/**
 * Slack live-streaming draft message.
 *
 * Brigade agents normally deliver one FINAL chunked reply (see
 * `inbound-pipeline.dispatchTurn` → `adapter.sendText`). This module adds the
 * OPTIONAL progressive-edit behavior: post a placeholder message on the first
 * content, then `chat.update` it with the accumulating answer as tokens arrive —
 * THROTTLED to roughly one edit per second so a long reply doesn't hammer the
 * Web API. When the running text outgrows the per-message limit the stream
 * FINALIZES the current message at its last safe chunk boundary and ROLLS to a
 * fresh message for the overflow, so a multi-message reply streams naturally.
 *
 * Design notes (vs the simpler one-shot send):
 *   - Transport-agnostic + pure-ish: the two Slack calls (`postMessage`,
 *     `update`) are INJECTED, so the throttle / roll / finalize state machine is
 *     unit-tested with fakes and never imports `@slack/web-api`.
 *   - Throttle window: edits coalesce — `update(text)` only records the latest
 *     text; the loop flushes at most once per `throttleMs`. `flush()` forces an
 *     immediate delivery (used between throttle ticks and on finalize).
 *   - Char-limit roll: when an edit would exceed the limit, the current message
 *     is finalized to the largest chunk that fits (split on a paragraph /
 *     newline / space boundary) and the remainder starts a NEW message.
 *   - Render hook: `renderText` converts a markdown chunk to Slack mrkdwn (same
 *     `markdownToSlackMrkdwn` the final path uses). A render that throws or
 *     yields empty text falls back to the plain chunk so a half-streamed code
 *     fence never wedges the stream.
 *   - Idempotent finalize: `finalize(text)` is safe to call once at turn end —
 *     it flushes the final text and stops the loop. After finalize the stream is
 *     inert.
 *
 * This is the Slack-native analogue of `telegram/draft-stream.ts` — the same
 * state machine, with Slack's string `ts` message ids and Slack's `mrkdwn` (no
 * per-message parse mode; the adapter sends every chunk with `mrkdwn: true`).
 */

/** Slack's practical per-message body limit for a streamed reply (chars). */
export const SLACK_STREAM_MAX_CHARS = 8000;
/** Default minimum gap between edits (≈ 1 edit/sec, Web API friendly). */
export const DEFAULT_THROTTLE_MS = 1000;
/** Floor on the throttle so a misconfig can't spam the API. */
const MIN_THROTTLE_MS = 250;

/** Rendered preview text (Slack always sends with `mrkdwn: true`, so no mode field). */
export interface DraftRender {
	text: string;
}

/** Injected Slack transport — exactly the two calls the stream needs. */
export interface DraftStreamTransport {
	/** Post a new message; returns its `ts` (Slack's message id). */
	postMessage(text: string, opts: { threadId?: string }): Promise<{ ts: string }>;
	/** Update a previously-posted message's text. */
	updateMessage(ts: string, text: string): Promise<void>;
}

export interface CreateDraftStreamParams {
	transport: DraftStreamTransport;
	/** Thread ts for the FIRST (placeholder) post. */
	threadId?: string;
	/** Minimum ms between edits. Clamped to ≥ 250. Default 1000. */
	throttleMs?: number;
	/** Per-message char cap. Clamped to ≤ 8000. Default 8000. */
	maxChars?: number;
	/** Convert a markdown chunk to Slack mrkdwn (or plain on failure). */
	renderText?: (text: string) => DraftRender;
	/** Best-effort logger for non-fatal stream hiccups. */
	warn?: (message: string) => void;
}

/**
 * A live draft stream. `update` records the latest full answer text; `finalize`
 * flushes it one last time and stops. `messageIds` lists every message the
 * stream materialized (the last one is the "live" one).
 */
export interface DraftStream {
	/** Record the latest accumulated answer text (coalesced + throttled). */
	update(fullText: string): void;
	/** Force an immediate delivery of the pending text (between throttle ticks). */
	flush(): Promise<void>;
	/** Flush the final text and stop the stream. Idempotent. */
	finalize(fullText: string): Promise<void>;
	/** Stop the stream WITHOUT a final flush (abort path). Idempotent. */
	stop(): void;
	/** Ids (ts) of every message this stream sent (last = current live message). */
	messageIds(): string[];
	/** True once the stream has been finalized or stopped. */
	isDone(): boolean;
}

/**
 * Split `text` so the head fits within `limit` chars, preferring (in order) a
 * paragraph break, a newline, then a space, falling back to a hard cut. Returns
 * `[head, rest]`; `rest` is "" when the whole text fits.
 */
export function splitAtBoundary(text: string, limit: number): [string, string] {
	if (text.length <= limit) return [text, ""];
	const window = text.slice(0, limit);
	const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
	for (const idx of candidates) {
		// Require the boundary to land past the half-way mark so we don't emit a
		// tiny head and shove almost everything into the overflow message.
		if (idx > limit * 0.5) {
			return [text.slice(0, idx).trimEnd(), text.slice(idx).trimStart()];
		}
	}
	return [text.slice(0, limit), text.slice(limit)];
}

export function createDraftStream(params: CreateDraftStreamParams): DraftStream {
	const throttleMs = Math.max(MIN_THROTTLE_MS, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const maxChars = Math.min(SLACK_STREAM_MAX_CHARS, Math.max(1, params.maxChars ?? SLACK_STREAM_MAX_CHARS));
	const render = params.renderText ?? ((t: string): DraftRender => ({ text: t }));
	const warn = params.warn ?? (() => {});

	// Full accumulated answer text the agent has produced so far.
	let pending = "";
	// Text of the CURRENT (live) message that's already been delivered — used to
	// skip no-op edits and to know how much of `pending` belongs to this message.
	let liveDelivered = "";
	// Char offset into `pending` where the current live message STARTS. Each roll
	// advances this past the finalized head.
	let baseOffset = 0;
	const sentIds: string[] = [];
	let liveId: string | undefined;
	let done = false;
	let inFlight = false;
	let lastSentAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	/** The slice of `pending` that belongs to the current live message. */
	const liveSlice = (): string => pending.slice(baseOffset);

	/**
	 * Deliver the current live slice: post a placeholder on first content, edit
	 * thereafter, and roll to a new message when the slice exceeds `maxChars`.
	 * Re-entrancy guarded by `inFlight` so overlapping flushes serialize.
	 */
	const deliver = async (isFinal: boolean): Promise<void> => {
		if (done && !isFinal) return;
		if (inFlight) return;
		if (!liveSlice().trim()) return;
		inFlight = true;
		try {
			// Roll: finalize the current message at a boundary, start a new one for
			// the overflow. Loop because a very long burst can overflow twice. We
			// work against the UNTRIMMED live slice so `baseOffset` advances by the
			// exact number of `pending` chars consumed (including the boundary
			// whitespace `splitAtBoundary` drops), keeping the next message aligned.
			let rawSlice = liveSlice();
			while (rawSlice.trimEnd().length > maxChars) {
				const [head] = splitAtBoundary(rawSlice.trimEnd(), maxChars);
				await deliverOne(head);
				// Advance past everything up to and including the boundary: find where
				// the trimmed head ends in the raw slice, then skip following
				// whitespace so the next message starts on real content.
				const headEnd = rawSlice.indexOf(head) + head.length;
				let advance = headEnd;
				while (advance < rawSlice.length && /\s/.test(rawSlice[advance] ?? "")) advance++;
				baseOffset += advance;
				liveDelivered = "";
				liveId = undefined;
				rawSlice = liveSlice();
			}
			const slice = rawSlice.trimEnd();
			if (slice && (slice !== liveDelivered || isFinal)) {
				await deliverOne(slice);
			}
			lastSentAt = Date.now();
		} finally {
			inFlight = false;
		}
	};

	/** Post-or-edit a single message body (≤ maxChars). */
	const deliverOne = async (body: string): Promise<void> => {
		let rendered: DraftRender;
		try {
			rendered = render(body);
			if (!rendered.text.trim()) rendered = { text: body };
		} catch {
			rendered = { text: body };
		}
		// A render can inflate length (mrkdwn entities); guard the hard cap.
		if (rendered.text.length > SLACK_STREAM_MAX_CHARS) {
			rendered = { text: body.slice(0, maxChars) };
		}
		try {
			if (typeof liveId === "string") {
				if (rendered.text === liveDelivered) return;
				await params.transport.updateMessage(liveId, rendered.text);
			} else {
				const sent = await params.transport.postMessage(rendered.text, {
					...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
				});
				liveId = sent.ts;
				sentIds.push(sent.ts);
			}
			liveDelivered = rendered.text;
		} catch (err) {
			// A post / edit failure must never wedge the turn — the final-only
			// fallback in the pipeline still delivers the complete reply.
			warn(`slack stream deliver failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/** Schedule a throttled flush if one isn't already pending. */
	const scheduleFlush = (): void => {
		if (done || timer || inFlight) return;
		const elapsed = Date.now() - lastSentAt;
		const wait = elapsed >= throttleMs ? 0 : throttleMs - elapsed;
		timer = setTimeout(() => {
			timer = undefined;
			void deliver(false);
		}, wait);
	};

	return {
		update(fullText: string): void {
			if (done) return;
			if (typeof fullText !== "string") return;
			pending = fullText;
			scheduleFlush();
		},
		async flush(): Promise<void> {
			if (done) return;
			clearTimer();
			await deliver(false);
		},
		async finalize(fullText: string): Promise<void> {
			if (done) {
				return;
			}
			clearTimer();
			if (typeof fullText === "string") pending = fullText;
			// Drain: deliver until the live slice is fully sent (handles a final
			// burst that rolls into one or more new messages).
			await deliver(true);
			done = true;
		},
		stop(): void {
			clearTimer();
			done = true;
		},
		messageIds(): string[] {
			return [...sentIds];
		},
		isDone(): boolean {
			return done;
		},
	};
}
