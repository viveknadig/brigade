/**
 * Retry with exponential backoff for transient upstream failures.
 *
 * The web-search and web-fetch providers all talk to remote APIs that
 * occasionally rate-limit (429) or return transient 5xx errors. Without
 * retry the agent loop blows up the entire turn; with retry we get one
 * or two cheap re-attempts before surfacing the error.
 *
 * Honors:
 *   - `Retry-After` header (seconds or HTTP-date), capped at 30s
 *   - Exponential base + jitter so we don't synchronize-retry against the
 *     upstream
 *   - `AbortSignal` propagation so a cancelled agent turn doesn't keep
 *     retrying after the user cancels
 *
 * Retries on:
 *   - `response.status === 429`
 *   - `response.status >= 500`
 *   - Caller-supplied `isTransient` predicate when set
 *
 * Does NOT retry on:
 *   - 4xx other than 429 (those are caller bugs)
 *   - Aborted requests (the caller chose to abort)
 *   - `RetryGiveUpError` thrown from inside the fetcher
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

export class RetryGiveUpError extends Error {
	readonly retryCause?: unknown;
	constructor(reason: string, retryCause?: unknown) {
		super(`retry give-up: ${reason}`);
		this.name = "RetryGiveUpError";
		this.retryCause = retryCause;
	}
}

export interface RetryOptions {
	/** Hard cap on attempts. 1 = no retry. Default 3. */
	maxAttempts?: number;
	/** Base delay in ms; doubled each retry plus jitter. Default 500. */
	baseDelayMs?: number;
	/** Hard cap on a single sleep between attempts. Default 30 000. */
	maxDelayMs?: number;
	/** Optional caller-supplied predicate to recognise transient errors. */
	isTransient?: (err: unknown) => boolean;
	/** Cancellation signal — stops retry loop if aborted. */
	signal?: AbortSignal;
	/** Logger hook fired on each retry attempt — `attempt` is 1-indexed. */
	onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

/**
 * Wrap a Response-returning function with retry. The caller's `fetcher`
 * is invoked up to `maxAttempts` times; if it returns a 429 or 5xx, the
 * response body is drained and a retry is scheduled. If it throws and
 * the error matches `isTransient`, retry the same way.
 */
export async function fetchWithRetry(
	fetcher: () => Promise<Response>,
	opts: RetryOptions = {},
): Promise<Response> {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelay = Math.max(0, opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
	const maxDelay = Math.max(baseDelay, opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
	const isTransient = opts.isTransient ?? defaultIsTransient;

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (opts.signal?.aborted) {
			throw opts.signal.reason ?? new Error("aborted");
		}
		try {
			const response = await fetcher();
			if (!shouldRetryResponse(response) || attempt === maxAttempts) {
				return response;
			}
			// Drain the body so the socket can be reused.
			try {
				await response.arrayBuffer();
			} catch {
				// best-effort drain — proceed regardless.
			}
			const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
			const delay = computeDelay(attempt, baseDelay, maxDelay, retryAfter);
			opts.onRetry?.({
				attempt,
				delayMs: delay,
				reason: `HTTP ${response.status}`,
			});
			await sleep(delay, opts.signal);
		} catch (err) {
			if (err instanceof RetryGiveUpError) throw err.retryCause ?? err;
			lastError = err;
			if (attempt === maxAttempts) throw err;
			if (!isTransient(err)) throw err;
			const delay = computeDelay(attempt, baseDelay, maxDelay, null);
			opts.onRetry?.({
				attempt,
				delayMs: delay,
				reason: (err instanceof Error ? err.message : String(err)).slice(0, 100),
			});
			await sleep(delay, opts.signal);
		}
	}
	// Loop body always returns or throws; unreachable.
	throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
}

function shouldRetryResponse(response: Response): boolean {
	return response.status === 429 || response.status >= 500;
}

/** Treat fetch network errors + `AbortError` from our own timeout as transient. */
function defaultIsTransient(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: unknown; code?: unknown; message?: unknown };
	const msg = typeof e.message === "string" ? e.message : "";
	if (typeof e.name === "string") {
		if (e.name === "AbortError" && /timeout/i.test(msg)) return true;
		if (e.name === "TimeoutError") return true;
	}
	if (typeof e.code === "string") {
		if (
			e.code === "ECONNRESET" ||
			e.code === "ECONNREFUSED" ||
			e.code === "ETIMEDOUT" ||
			e.code === "ENETUNREACH" ||
			e.code === "EAI_AGAIN"
		) {
			return true;
		}
	}
	if (/fetch\s+failed|network\s+error|reset|timeout/i.test(msg)) return true;
	return false;
}

/**
 * Parse a `Retry-After` header. Accepts integer-seconds OR an HTTP-date.
 * Returns the wait in ms, capped at the default ceiling. Returns null on
 * malformed input.
 */
function parseRetryAfter(raw: string | null): number | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) {
		return Math.min(DEFAULT_MAX_DELAY_MS, Number(trimmed) * 1000);
	}
	const date = Date.parse(trimmed);
	if (Number.isFinite(date)) {
		return Math.min(DEFAULT_MAX_DELAY_MS, Math.max(0, date - Date.now()));
	}
	return null;
}

function computeDelay(
	attempt: number,
	base: number,
	max: number,
	overrideMs: number | null,
): number {
	if (overrideMs !== null) return Math.min(max, Math.max(0, overrideMs));
	// Exponential growth + 25 % jitter so a fleet of clients doesn't
	// synchronize-retry against the same upstream.
	const expo = base * 2 ** (attempt - 1);
	const jitter = expo * 0.25 * Math.random();
	return Math.min(max, Math.floor(expo + jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new Error("aborted"));
		};
		if (signal?.aborted) {
			cleanup();
			reject(signal.reason ?? new Error("aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
