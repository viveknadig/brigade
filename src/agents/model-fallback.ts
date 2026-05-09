// Multi-model fallback orchestrator.
//
// Wraps an inner attempt fn with a candidate chain: if the primary model
// fails with a transient or model-specific error, the next candidate is
// tried automatically. Same-model retries are handled inside `runWithRetry`;
// this layer rotates *across* models when same-model retry is exhausted or
// when the failure category demands a new candidate (model_not_found,
// auth_permanent for the only profile on a provider).
//
// Per-(provider, reason) cooldown slots prevent a thundering rate-limit
// storm from cycling all candidates within the same second. Each (provider,
// reason) pair can absorb at most one transient probe per fallback run; once
// a probe spends the slot, the candidate goes on cooldown for the rest of
// this run regardless of subsequent retries.
//
// Allowlist enforcement: only candidates whose `provider/model` key appears
// in `agents.defaults.models` (when configured) are eligible as fallbacks.
// The explicit primary always runs even if not in the allowlist — the user
// asked for it.

import {
  classifyErrorReason,
  isBrigadeRetryError,
  summariseError,
  type RetryReason,
} from "./error-classifier.js";
import { getRetryPolicy, runWithRetry } from "./retry-policy.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";

const log = createSubsystemLogger("loop/fallback");

export interface ModelCandidate {
  provider: string;
  model: string;
  // True for the user-requested primary; false for fallback candidates from
  // the allowlist. Primary candidates bypass the allowlist filter.
  isPrimary: boolean;
}

export interface FallbackAttempt {
  provider: string;
  model: string;
  reason: RetryReason;
  errorSummary: string;
  status?: number;
}

export class FallbackExhaustedError extends Error {
  readonly attempts: FallbackAttempt[];
  readonly soonestRetryHintMs?: number;

  constructor(attempts: FallbackAttempt[], soonestRetryHintMs?: number) {
    const summary = attempts
      .map((a) => `${a.provider}/${a.model}: ${a.reason} (${a.errorSummary})`)
      .join(" | ");
    super(`All ${attempts.length} candidate model(s) failed: ${summary}`);
    this.name = "FallbackExhaustedError";
    this.attempts = attempts;
    this.soonestRetryHintMs = soonestRetryHintMs;
  }
}

export interface RunWithModelFallbackArgs<T> {
  primary: ModelCandidate;
  // Ordered list of fallback candidates to try if the primary fails. Already
  // filtered against the allowlist at the call site (so this module doesn't
  // need to know the config schema).
  fallbacks: ModelCandidate[];
  // Inner work — invoked once per attempted candidate. The function should
  // *itself* call `runWithRetry` for same-model retries. This wrapper only
  // rotates candidates after `attempt` rejects.
  attempt: (candidate: ModelCandidate, signal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  onCandidateAttempted?: (info: FallbackAttempt) => void;
}

export interface RunWithModelFallbackResult<T> {
  result: T;
  candidate: ModelCandidate;
  attempts: FallbackAttempt[];
}

/**
 * Cap on `LiveSessionModelSwitchError` retries within a single fallback run.
 * Mirrors OpenClaw's `MAX_LIVE_SWITCH_RETRIES = 5` (`agent-command.ts:849`).
 * Without this, a hook that throws a fresh switch error on every attempt
 * would loop forever (each new candidate rejecting with another switch
 * request). 5 is more than any reasonable user-driven /model swap cascade
 * — beyond that something is wrong and we'd rather fail loud.
 */
const MAX_LIVE_SWITCH_RETRIES = 5;

export async function runWithModelFallback<T>(
  args: RunWithModelFallbackArgs<T>,
): Promise<RunWithModelFallbackResult<T>> {
  const candidates: ModelCandidate[] = [args.primary, ...args.fallbacks];
  const attempts: FallbackAttempt[] = [];
  // (provider, reason) → exhausted? Once a (provider, reason) pair has
  // absorbed a probe in this run, further candidates on the same provider
  // skip ahead rather than re-probing.
  const exhaustedSlots = new Set<string>();
  // Counter for the live-switch guard above. Resets per call to
  // runWithModelFallback (each user prompt gets its own budget).
  let liveSwitchRetries = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    if (args.signal?.aborted) {
      throw args.signal.reason ?? new Error("Aborted");
    }

    log.info("attempting candidate", {
      candidate: `${candidate.provider}/${candidate.model}`,
      isPrimary: candidate.isPrimary,
      attemptIndex: i,
    });

    try {
      const result = await args.attempt(candidate, args.signal);
      log.info("candidate succeeded", {
        candidate: `${candidate.provider}/${candidate.model}`,
        attemptIndex: i,
      });
      return { result, candidate, attempts };
    } catch (err) {
      // Bare aborts surface immediately — never roll past a user cancel.
      if (isAbortError(err)) throw err;

      // Live model switch — caller signalled mid-attempt that the active
      // turn should rotate to a different (provider, modelId). Splice the
      // requested candidate to the head of the remaining queue and re-enter
      // the loop without consuming a probe slot or recording the request
      // as a "failure". The previous attempt's actual outcome (whatever it
      // was) is discarded — the user asked for a different model, they
      // get the result of the new model.
      //
      // Max-retries guard mirrors OpenClaw's `MAX_LIVE_SWITCH_RETRIES = 5`
      // (`agent-command.ts:849`). A buggy hook could otherwise chain
      // switches forever (each new model immediately throws another
      // LiveSessionModelSwitchError) — surface as a hard error after 5.
      if (isLiveSessionModelSwitchError(err)) {
        if (liveSwitchRetries >= MAX_LIVE_SWITCH_RETRIES) {
          log.error("live model switch retries exhausted", {
            from: `${candidate.provider}/${candidate.model}`,
            to: `${err.nextProvider}/${err.nextModel}`,
            retries: liveSwitchRetries,
            cap: MAX_LIVE_SWITCH_RETRIES,
          });
          throw new Error(
            `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`,
            { cause: err },
          );
        }
        liveSwitchRetries++;
        log.info("live model switch requested mid-attempt", {
          from: `${candidate.provider}/${candidate.model}`,
          to: `${err.nextProvider}/${err.nextModel}`,
          retry: liveSwitchRetries,
        });
        const switched: ModelCandidate = {
          provider: err.nextProvider,
          model: err.nextModel,
          isPrimary: false,
        };
        // Insert as the next-to-try without disturbing the rest of the
        // chain. `i` stays put; the for-loop's i++ will land on this.
        candidates.splice(i + 1, 0, switched);
        continue;
      }

      const reason = classifyErrorReason(err);
      const status = isBrigadeRetryError(err) ? err.status : undefined;
      const errorSummary = summariseError(err);
      const info: FallbackAttempt = {
        provider: candidate.provider,
        model: candidate.model,
        reason,
        errorSummary,
        status,
      };
      attempts.push(info);
      args.onCandidateAttempted?.(info);

      const policy = getRetryPolicy(reason);
      log.warn("candidate failed", {
        candidate: `${candidate.provider}/${candidate.model}`,
        reason,
        status,
        willRotate: i + 1 < candidates.length,
        rotateAuthProfile: policy.rotateAuthProfile,
        rotateModel: policy.rotateModel,
        consumesProbeSlot: policy.consumesProbeSlot,
      });

      // Probe-slot accounting — track per (provider, reason) so a chained
      // rate-limit storm doesn't burn through every candidate.
      if (policy.consumesProbeSlot) {
        exhaustedSlots.add(`${candidate.provider}::${reason}`);
      }

      // Categories that should fail immediately rather than rotate. These
      // mean retrying with any candidate would surface the same hard error.
      if (reason === "auth_permanent" || reason === "session_expired") {
        // For auth_permanent on the primary, give fallbacks a chance — a
        // different provider key may work. For session_expired, the upstream
        // session is gone; rotating providers won't fix that.
        if (reason === "session_expired") throw err;
      }
      if (reason === "format") {
        // The same body re-fails on every candidate. Surface the original.
        throw err;
      }

      // Skip the next candidate if it's on a slot that's already exhausted
      // for this run.
      while (i + 1 < candidates.length) {
        const next = candidates[i + 1];
        if (!next) break;
        if (exhaustedSlots.has(`${next.provider}::${reason}`)) {
          log.debug("skipping candidate on exhausted slot", {
            candidate: `${next.provider}/${next.model}`,
            reason,
          });
          i++;
          continue;
        }
        break;
      }
    }
  }

  throw new FallbackExhaustedError(attempts);
}

// Live-session model switch error.
//
// Thrown from inside an `attempt` callback when a different (provider,
// modelId) should serve the in-flight turn. The resilient runner catches
// this in `runWithModelFallback` / `runResilient` and rotates to the
// requested candidate before retrying — no FallbackExhaustedError is
// raised, no probe-slot is consumed.
//
// Today's CLI can't throw this mid-stream because Pi 0.70.x's
// `session.prompt` doesn't accept an AbortSignal — a `/model X` command
// at the CLI persists to sessions.json and takes effect on the NEXT
// turn (see cli/commands/agent.ts). Future channel adapters (gateway
// WebSocket, IDE bridge, etc.) that DO have a side channel into the
// agent loop can throw this from a hook to drive a true live switch.
export class LiveSessionModelSwitchError extends Error {
  readonly nextProvider: string;
  readonly nextModel: string;
  readonly authProfileId?: string;

  constructor(args: { provider: string; model: string; authProfileId?: string }) {
    super(`Live session model switch requested: ${args.provider}/${args.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.nextProvider = args.provider;
    this.nextModel = args.model;
    this.authProfileId = args.authProfileId;
  }
}

export function isLiveSessionModelSwitchError(value: unknown): value is LiveSessionModelSwitchError {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { name?: unknown }).name === "LiveSessionModelSwitchError"
  );
}

// Convenience that combines `runWithRetry` (same-model retries) with
// `runWithModelFallback` (across-model rotation). Most callers should use
// this rather than wiring the two separately.
export interface RunResilientArgs<T> {
  primary: ModelCandidate;
  fallbacks: ModelCandidate[];
  invoke: (candidate: ModelCandidate, signal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
}

export async function runResilient<T>(args: RunResilientArgs<T>): Promise<RunWithModelFallbackResult<T>> {
  return runWithModelFallback({
    primary: args.primary,
    fallbacks: args.fallbacks,
    signal: args.signal,
    attempt: (candidate, signal) =>
      runWithRetry({
        ctx: { provider: candidate.provider, model: candidate.model },
        signal,
        attempt: (_attemptIndex, innerSignal) => args.invoke(candidate, innerSignal),
      }),
  });
}

function isAbortError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as { name?: unknown; code?: unknown };
  return v.name === "AbortError" || v.code === "ABORT_ERR" || v.code === 20;
}
