// Error classifier for the Brigade agent loop.
//
// Single responsibility: take any thrown value and bucket it into one of the
// retry-policy categories below. Everything that decides "retry / cool down /
// fail fast / rotate model" reads from `classifyError`.
//
// The taxonomy is deliberately small. Ten categories cover the failure modes
// the loop has to react to differently; anything else collapses into
// "unknown" and inherits the unknown-class retry policy.
//
// Inputs we have to classify across:
//   • HTTP status codes (most providers surface them on the error)
//   • Provider-shape error codes (e.g. ZAI 1311 = quota, 1113 = key revoked)
//   • Free-text messages — vendors disagree on phrasing for the same root
//     cause, so the regex set must cast a wide net per category
//   • Native runtime errors (TimeoutError, AbortError, ECONNRESET, …)
//   • Already-classified BrigadeRetryError thrown from a prior layer

export type RetryReason =
  | "auth"            // bad/expired credential — try a different profile, not retry-in-place
  | "auth_permanent"  // key disabled/revoked — never retry this profile
  | "format"          // request shape rejected — retrying with the same body is useless
  | "rate_limit"      // 429 / quota — backoff + cooldown + rotate profile
  | "overloaded"      // 503 / 529 / "high demand" — backoff, then probe
  | "billing"         // 402 / insufficient credits — semi-persistent, may need user action
  | "timeout"         // network/connect/read timeout — retry transient
  | "model_not_found" // provider doesn't know this model — rotate to fallback
  | "session_expired" // upstream session/conversation expired — fail fast or refresh
  | "unknown";        // catch-all; treated as transient at the policy layer

export interface ClassificationContext {
  provider?: string;
  model?: string;
}

// Classified error wrapper. Throw this from anywhere in the loop to commit to
// a category without re-running the heuristics. The retry policy reads
// `reason` directly without re-classifying.
export class BrigadeRetryError extends Error {
  readonly reason: RetryReason;
  readonly status?: number;
  readonly code?: string;
  readonly provider?: string;
  readonly model?: string;

  constructor(args: {
    message: string;
    reason: RetryReason;
    status?: number;
    code?: string;
    provider?: string;
    model?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause as Error } : undefined);
    this.name = "BrigadeRetryError";
    this.reason = args.reason;
    this.status = args.status;
    this.code = args.code;
    this.provider = args.provider;
    this.model = args.model;
  }
}

export function isBrigadeRetryError(value: unknown): value is BrigadeRetryError {
  if (!value || typeof value !== "object") return false;
  const v = value as { name?: unknown; reason?: unknown };
  return v.name === "BrigadeRetryError" && typeof v.reason === "string";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern sets — lifted from observed provider error surfaces. The same root
// cause shows up under different phrasings across Anthropic, OpenAI, Gemini,
// Groq, OpenRouter, Ollama, ZAI, Together, Fireworks, etc. Cast a wide net.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ ]limit/i,
  /too many (?:concurrent )?requests/i,
  /throttling(?:exception)?/i,
  /\b429\b/,
  /\bmodel_cooldown\b/i,
  /exceeded your current quota/i,
  /resource has been exhausted/i,
  /\bquota exceeded\b/i,
  /\bresource_exhausted\b/i,
  /\btpm\b/i,
  /tokens per (?:minute|day)/i,
  /requests per (?:minute|day)/i,
];

const OVERLOADED_PATTERNS: RegExp[] = [
  /overloaded_error/i,
  /"type"\s*:\s*"overloaded_error"/i,
  /\boverloaded\b/i,
  /service[_ ]unavailable.*(?:overload|capacity|high[_ ]demand)/i,
  /\bhigh demand\b/i,
  /\b529\b/,
];

const BILLING_PATTERNS: RegExp[] = [
  /\b402\b/,
  /payment required/i,
  /insufficient credits/i,
  /insufficient[_ ]quota/i,
  /credit balance/i,
  /plans? & billing/i,
  /insufficient balance/i,
  /upgrade (?:your )?plan/i,
  /"code"\s*:\s*1311\b/, // ZAI quota
];

// Substrings inside a 402 message that flip "billing" → "rate_limit" because
// the provider is using the 402 status to indicate a daily/weekly cap rather
// than missing funds. Probing again on a fresh window will succeed.
const RATE_LIMITED_402_HINTS: RegExp[] = [
  /(?:daily|weekly|monthly)\s*(?:rate\s*)?limit/i,
  /try (?:again|later)/i,
  /retry after/i,
  /cool[ -]?down/i,
];

const AUTH_PERMANENT_PATTERNS: RegExp[] = [
  /api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)/i,
  /key (?:has been|was) (?:disabled|revoked|deactivated)/i,
  /account (?:has been|was) deactivated/i,
  /not allowed for this organi[sz]ation/i,
  /"code"\s*:\s*1113\b/, // ZAI key revoked
];

const AUTH_PATTERNS: RegExp[] = [
  /incorrect api key/i,
  /invalid (?:token|api[_ ]?key|credential)/i,
  /authenticat(?:ion|e)/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /access denied/i,
  /insufficient permissions/i,
  /\b(?:401|403)\b/,
  /token (?:has |was )?expired/i,
  /oauth token refresh failed/i,
];

const TIMEOUT_PATTERNS: RegExp[] = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bdeadline exceeded\b/i,
  /\beconn(?:refused|reset|aborted)\b/i,
  /\betimedout\b/i,
  /without sending (?:any )?chunks?/i,
  /\bstop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
  /\bfinish_reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
  /socket hang up/i,
  /network error/i,
];

const FORMAT_PATTERNS: RegExp[] = [
  /string should match pattern/i,
  /tool_use\.id/i,
  /tool_use_id/i,
  /invalid request format/i,
  /tool call id was.*must be/i,
  /messages\.\d+\.content\.\d+\.tool_use\.id/i,
];

const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /model[_ ]?not[_ ]?found/i,
  /unknown model/i,
  /model .*?(?:does not exist|is not available)/i,
  /no such model/i,
];

const SESSION_EXPIRED_PATTERNS: RegExp[] = [
  /session not found/i,
  /session (?:has )?expired/i,
  /conversation not found/i,
  /session id not found/i,
  /conversation id not found/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Status-code → reason. Where the message is informative the message wins
// (e.g. a 422 with "string should match pattern" is format, not rate_limit).
// ─────────────────────────────────────────────────────────────────────────────

function classifyByStatus(status: number, message: string): RetryReason | null {
  switch (status) {
    case 401:
    case 403:
      return matchAny(message, AUTH_PERMANENT_PATTERNS) ? "auth_permanent" : "auth";
    case 402:
      // 402 is overloaded with meanings — providers use it for both "you owe
      // money" and "you've hit the daily cap, try again". Inspect the body.
      if (matchAny(message, RATE_LIMITED_402_HINTS)) return "rate_limit";
      return "billing";
    case 404:
      return matchAny(message, MODEL_NOT_FOUND_PATTERNS) ? "model_not_found" : null;
    case 408:
      return "timeout";
    case 410:
      return matchAny(message, SESSION_EXPIRED_PATTERNS) ? "session_expired" : "timeout";
    case 422:
      return matchAny(message, FORMAT_PATTERNS) ? "format" : null;
    case 429:
      return "rate_limit";
    case 499:
      // Cloudflare "client closed request" — sometimes reported by edge
      // proxies during overload. Inspect message; default to timeout.
      return matchAny(message, OVERLOADED_PATTERNS) ? "overloaded" : "timeout";
    case 500:
    case 502:
    case 504:
      return "timeout";
    case 503:
      return matchAny(message, OVERLOADED_PATTERNS) ? "overloaded" : "timeout";
    case 529:
      return "overloaded";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entry point. Walk the error chain (cause/reason) in case the
// status/message lives one or two layers deep — common for fetch wrappers.
// ─────────────────────────────────────────────────────────────────────────────

export function classifyError(value: unknown, _ctx?: ClassificationContext): RetryReason {
  if (isBrigadeRetryError(value)) return value.reason;
  if (value === null || value === undefined) return "unknown";

  const visited = new Set<unknown>();
  const stack: unknown[] = [value];
  let firstStatus: number | undefined;
  let firstMessage = "";

  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || cur === undefined) continue;
    if (typeof cur !== "object") {
      const msg = String(cur);
      if (!firstMessage) firstMessage = msg;
      const byPattern = classifyByMessage(msg);
      if (byPattern) return byPattern;
      continue;
    }
    if (visited.has(cur)) continue;
    visited.add(cur);

    const obj = cur as {
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
      reason?: unknown;
      name?: unknown;
      code?: unknown;
    };

    // AbortError / TimeoutError surface as native error names.
    if (obj.name === "AbortError") return "unknown";
    if (obj.name === "TimeoutError") return "timeout";

    const status = readNumeric(obj.status) ?? readNumeric(obj.statusCode) ?? readNumeric(obj.response?.status);
    if (status !== undefined && firstStatus === undefined) firstStatus = status;

    const message = typeof obj.message === "string" ? obj.message : "";
    if (message && !firstMessage) firstMessage = message;

    if (status !== undefined) {
      const byStatus = classifyByStatus(status, message);
      if (byStatus) return byStatus;
    }
    if (message) {
      const byPattern = classifyByMessage(message);
      if (byPattern) return byPattern;
    }

    // ECONNRESET / ETIMEDOUT bubble up as `code` on Node fetch errors.
    const code = typeof obj.code === "string" ? obj.code : "";
    if (code) {
      if (/^E(?:CONN(?:RESET|REFUSED|ABORTED)|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE)$/i.test(code)) {
        return "timeout";
      }
    }

    if (obj.cause !== undefined && obj.cause !== cur) stack.push(obj.cause);
    if (obj.reason !== undefined && obj.reason !== cur) stack.push(obj.reason);
  }

  // Last-resort: if we collected a status with no message-based hit, classify
  // by status alone.
  if (firstStatus !== undefined) {
    const byStatus = classifyByStatus(firstStatus, firstMessage);
    if (byStatus) return byStatus;
  }
  return "unknown";
}

function classifyByMessage(message: string): RetryReason | null {
  if (!message) return null;
  if (matchAny(message, AUTH_PERMANENT_PATTERNS)) return "auth_permanent";
  if (matchAny(message, BILLING_PATTERNS)) {
    return matchAny(message, RATE_LIMITED_402_HINTS) ? "rate_limit" : "billing";
  }
  if (matchAny(message, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchAny(message, OVERLOADED_PATTERNS)) return "overloaded";
  if (matchAny(message, AUTH_PATTERNS)) return "auth";
  if (matchAny(message, MODEL_NOT_FOUND_PATTERNS)) return "model_not_found";
  if (matchAny(message, SESSION_EXPIRED_PATTERNS)) return "session_expired";
  if (matchAny(message, FORMAT_PATTERNS)) return "format";
  if (matchAny(message, TIMEOUT_PATTERNS)) return "timeout";
  return null;
}

function matchAny(haystack: string, patterns: RegExp[]): boolean {
  for (const p of patterns) if (p.test(haystack)) return true;
  return false;
}

function readNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic refusal-token defense. A specific magic literal can be embedded
// in user content to coerce Anthropic models into refusing the next turn.
// Strip it before any prompt assembly and after any session replay so the
// transcript itself can't carry the payload across turns.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_REFUSAL_SENTINEL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_REFUSAL_SENTINEL_REDACTED = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

export function scrubAnthropicRefusalSentinel(text: string): string {
  if (!text || !text.includes(ANTHROPIC_REFUSAL_SENTINEL)) return text;
  return text.replaceAll(ANTHROPIC_REFUSAL_SENTINEL, ANTHROPIC_REFUSAL_SENTINEL_REDACTED);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: format an error for a single-line log/diagnostic. Kept short —
// the full error chain still goes to the structured logger fields.
// ─────────────────────────────────────────────────────────────────────────────

export function summariseError(value: unknown): string {
  if (isBrigadeRetryError(value)) {
    const status = value.status !== undefined ? ` status=${value.status}` : "";
    const provider = value.provider ? ` provider=${value.provider}` : "";
    return `${value.reason}${provider}${status}: ${value.message}`;
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
