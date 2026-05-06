import { test } from "node:test";
import assert from "node:assert/strict";

import { BrigadeRetryError } from "./error-classifier.js";
import {
  FallbackExhaustedError,
  LiveSessionModelSwitchError,
  isLiveSessionModelSwitchError,
  runWithModelFallback,
} from "./model-fallback.js";

test("runWithModelFallback: primary succeeds → returns immediately", async () => {
  const result = await runWithModelFallback({
    primary: { provider: "anthropic", model: "opus", isPrimary: true },
    fallbacks: [{ provider: "openai", model: "gpt-4", isPrimary: false }],
    attempt: async (c) => `ok-${c.provider}/${c.model}`,
  });
  assert.equal(result.result, "ok-anthropic/opus");
  assert.equal(result.candidate.model, "opus");
  assert.equal(result.attempts.length, 0);
});

test("runWithModelFallback: primary fails non-fatally → falls back to next", async () => {
  let calls = 0;
  const result = await runWithModelFallback({
    primary: { provider: "anthropic", model: "opus", isPrimary: true },
    fallbacks: [{ provider: "openai", model: "gpt-4", isPrimary: false }],
    attempt: async (c) => {
      calls++;
      if (c.provider === "anthropic") {
        throw new BrigadeRetryError({
          message: "model gone",
          reason: "model_not_found",
          provider: "anthropic",
        });
      }
      return `ok-${c.provider}/${c.model}`;
    },
  });
  assert.equal(result.result, "ok-openai/gpt-4");
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]!.reason, "model_not_found");
});

test("runWithModelFallback: format error fails fast across all candidates", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWithModelFallback({
        primary: { provider: "anthropic", model: "opus", isPrimary: true },
        fallbacks: [{ provider: "openai", model: "gpt-4", isPrimary: false }],
        attempt: async () => {
          calls++;
          throw new BrigadeRetryError({
            message: "tool_use_id mismatch",
            reason: "format",
          });
        },
      }),
    (err: unknown) =>
      err instanceof BrigadeRetryError && err.reason === "format",
  );
  // Format error must not rotate to fallback.
  assert.equal(calls, 1);
});

test("runWithModelFallback: session_expired surfaces immediately", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWithModelFallback({
        primary: { provider: "anthropic", model: "opus", isPrimary: true },
        fallbacks: [{ provider: "openai", model: "gpt-4", isPrimary: false }],
        attempt: async () => {
          calls++;
          throw new BrigadeRetryError({
            message: "session expired",
            reason: "session_expired",
          });
        },
      }),
  );
  assert.equal(calls, 1);
});

test("runWithModelFallback: per-(provider, reason) probe slots skip same-provider rate-limits", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWithModelFallback({
        primary: { provider: "anthropic", model: "opus", isPrimary: true },
        fallbacks: [
          { provider: "anthropic", model: "sonnet", isPrimary: false }, // same provider
          { provider: "openai", model: "gpt-4", isPrimary: false },
        ],
        attempt: async () => {
          calls++;
          throw new BrigadeRetryError({
            message: "rate limited",
            reason: "rate_limit",
            status: 429,
          });
        },
      }),
    (err: unknown) => err instanceof FallbackExhaustedError,
  );
  // Primary (anthropic/opus) consumes the slot.
  // Anthropic/sonnet is on the same exhausted slot → skipped.
  // openai/gpt-4 has a fresh slot → tried (and fails).
  assert.equal(calls, 2);
});

test("runWithModelFallback: pre-aborted signal short-circuits", async () => {
  const ac = new AbortController();
  ac.abort(new Error("user cancelled"));
  let calls = 0;
  await assert.rejects(() =>
    runWithModelFallback({
      primary: { provider: "anthropic", model: "opus", isPrimary: true },
      fallbacks: [],
      signal: ac.signal,
      attempt: async () => {
        calls++;
        return "ok";
      },
    }),
  );
  assert.equal(calls, 0);
});

test("runWithModelFallback: empty fallback list — primary failure becomes FallbackExhaustedError", async () => {
  await assert.rejects(
    () =>
      runWithModelFallback({
        primary: { provider: "anthropic", model: "opus", isPrimary: true },
        fallbacks: [],
        attempt: async () => {
          throw new BrigadeRetryError({
            message: "rate limited",
            reason: "rate_limit",
          });
        },
      }),
    (err: unknown) => {
      if (!(err instanceof FallbackExhaustedError)) return false;
      assert.equal(err.attempts.length, 1);
      assert.equal(err.attempts[0]!.reason, "rate_limit");
      return true;
    },
  );
});

test("isLiveSessionModelSwitchError: positive + negatives", () => {
  const sw = new LiveSessionModelSwitchError({ provider: "openai", model: "gpt-5" });
  assert.equal(isLiveSessionModelSwitchError(sw), true);
  assert.equal(isLiveSessionModelSwitchError(new Error("x")), false);
  assert.equal(isLiveSessionModelSwitchError(null), false);
  assert.equal(isLiveSessionModelSwitchError({ name: "LiveSessionModelSwitchError" }), true);
});

test("runWithModelFallback: LiveSessionModelSwitchError rotates to the requested model and runs it", async () => {
  let calls = 0;
  const seen: string[] = [];
  const result = await runWithModelFallback({
    primary: { provider: "anthropic", model: "opus", isPrimary: true },
    fallbacks: [{ provider: "openai", model: "gpt-4", isPrimary: false }],
    attempt: async (candidate) => {
      calls++;
      seen.push(`${candidate.provider}/${candidate.model}`);
      if (calls === 1) {
        // First attempt — caller asks to switch to a brand new model that
        // wasn't in the original chain.
        throw new LiveSessionModelSwitchError({
          provider: "google",
          model: "gemini-2.5-pro",
        });
      }
      return `served-by-${candidate.provider}/${candidate.model}`;
    },
  });
  assert.equal(result.result, "served-by-google/gemini-2.5-pro");
  assert.deepEqual(seen, ["anthropic/opus", "google/gemini-2.5-pro"]);
  // The switch should NOT have been recorded as a failed attempt.
  assert.equal(result.attempts.length, 0);
});

