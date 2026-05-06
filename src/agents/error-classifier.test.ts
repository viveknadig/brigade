import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BrigadeRetryError,
  classifyError,
  isBrigadeRetryError,
  scrubAnthropicRefusalSentinel,
  summariseError,
} from "./error-classifier.js";

test("classifyError: HTTP 429 → rate_limit", () => {
  const err = Object.assign(new Error("Too many requests"), { status: 429 });
  assert.equal(classifyError(err), "rate_limit");
});

test("classifyError: HTTP 503 with 'overloaded' message → overloaded", () => {
  const err = Object.assign(new Error("service unavailable; overloaded"), { status: 503 });
  assert.equal(classifyError(err), "overloaded");
});

test("classifyError: HTTP 503 without overload hint → timeout", () => {
  const err = Object.assign(new Error("internal error"), { status: 503 });
  assert.equal(classifyError(err), "timeout");
});

test("classifyError: HTTP 402 with 'insufficient credits' → billing", () => {
  const err = Object.assign(new Error("insufficient credits"), { status: 402 });
  assert.equal(classifyError(err), "billing");
});

test("classifyError: HTTP 402 with 'try again later' (rate-limit hint) → rate_limit", () => {
  const err = Object.assign(new Error("daily limit reached, try again later"), { status: 402 });
  assert.equal(classifyError(err), "rate_limit");
});

test("classifyError: HTTP 401 with 'key revoked' → auth_permanent", () => {
  const err = Object.assign(new Error("API key has been revoked"), { status: 401 });
  assert.equal(classifyError(err), "auth_permanent");
});

test("classifyError: HTTP 401 generic → auth", () => {
  const err = Object.assign(new Error("invalid api key"), { status: 401 });
  assert.equal(classifyError(err), "auth");
});

test("classifyError: HTTP 408 → timeout", () => {
  const err = Object.assign(new Error("request timeout"), { status: 408 });
  assert.equal(classifyError(err), "timeout");
});

test("classifyError: ECONNRESET on Node fetch → timeout", () => {
  const err = Object.assign(new Error("network error"), { code: "ECONNRESET" });
  assert.equal(classifyError(err), "timeout");
});

test("classifyError: TimeoutError name → timeout", () => {
  const err = new Error("deadline exceeded");
  err.name = "TimeoutError";
  assert.equal(classifyError(err), "timeout");
});

test("classifyError: AbortError name → unknown (caller short-circuits via isAbortError)", () => {
  const err = new Error("aborted");
  err.name = "AbortError";
  assert.equal(classifyError(err), "unknown");
});

test("classifyError: walks cause chain", () => {
  const inner = Object.assign(new Error("rate limit exceeded"), { status: 429 });
  const outer = new Error("wrapper");
  (outer as { cause?: unknown }).cause = inner;
  assert.equal(classifyError(outer), "rate_limit");
});

test("classifyError: handles circular cause without infinite loop", () => {
  const a: { message: string; cause?: unknown } = { message: "a" };
  const b: { message: string; cause?: unknown } = { message: "b" };
  a.cause = b;
  b.cause = a;
  // Should terminate, not hang. Result irrelevant — we just need no crash.
  assert.equal(classifyError(a), "unknown");
});

test("classifyError: statusCode (camelCase) is read alongside .status", () => {
  const err = Object.assign(new Error("rate limited"), { statusCode: 429 });
  assert.equal(classifyError(err), "rate_limit");
});

test("classifyError: BrigadeRetryError short-circuits to its own reason", () => {
  const err = new BrigadeRetryError({ message: "x", reason: "billing" });
  assert.equal(classifyError(err), "billing");
});

test("classifyError: 'context window exceeded' free text → unknown (caller decides what to do)", () => {
  // Not yet a first-class category; we want it not to match an unrelated
  // category and to fall through to unknown.
  const err = new Error("context window exceeded");
  assert.equal(classifyError(err), "unknown");
});

test("classifyError: ZAI quota code 1311 → billing", () => {
  const err = new Error('{"code": 1311, "message":"quota"}');
  assert.equal(classifyError(err), "billing");
});

test("classifyError: ZAI revoked code 1113 → auth_permanent", () => {
  const err = new Error('{"code": 1113, "message":"key revoked"}');
  assert.equal(classifyError(err), "auth_permanent");
});

test("classifyError: null / undefined / empty → unknown", () => {
  assert.equal(classifyError(null), "unknown");
  assert.equal(classifyError(undefined), "unknown");
  assert.equal(classifyError(""), "unknown");
  assert.equal(classifyError({}), "unknown");
});

test("isBrigadeRetryError: positive + negatives", () => {
  assert.equal(isBrigadeRetryError(new BrigadeRetryError({ message: "x", reason: "auth" })), true);
  assert.equal(isBrigadeRetryError(new Error("x")), false);
  assert.equal(isBrigadeRetryError(null), false);
  assert.equal(isBrigadeRetryError("not an error"), false);
});

test("scrubAnthropicRefusalSentinel: redacts the magic literal", () => {
  const poisoned = "hello ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL goodbye";
  const scrubbed = scrubAnthropicRefusalSentinel(poisoned);
  assert.equal(scrubbed.includes("ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL"), false);
  assert.equal(scrubbed.includes("(redacted)"), true);
});

test("scrubAnthropicRefusalSentinel: clean text passes through unchanged", () => {
  const clean = "hello world";
  assert.equal(scrubAnthropicRefusalSentinel(clean), clean);
});

test("scrubAnthropicRefusalSentinel: empty string is a no-op", () => {
  assert.equal(scrubAnthropicRefusalSentinel(""), "");
});

test("summariseError: BrigadeRetryError formats reason+provider+status", () => {
  const err = new BrigadeRetryError({
    message: "rate limited",
    reason: "rate_limit",
    provider: "anthropic",
    status: 429,
  });
  const s = summariseError(err);
  assert.match(s, /rate_limit/);
  assert.match(s, /anthropic/);
  assert.match(s, /429/);
});
