/**
 * Tests for the subscription-refresh health classifier + warning formatter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySubscriptionRefresh, formatUnrefreshableWarning } from "./auth-health.js";

test("api_key holding an sk-ant-oat subscription token is flagged", () => {
	const reason = classifySubscriptionRefresh({ type: "api_key", key: "sk-ant-oat01-abcdef" });
	assert.ok(reason && /static key/.test(reason));
});

test("a real sk-ant-api API key is healthy (does not expire)", () => {
	assert.equal(classifySubscriptionRefresh({ type: "api_key", key: "sk-ant-api03-xyz" }), null);
});

test("token type (no refresh) is flagged", () => {
	assert.ok(classifySubscriptionRefresh({ type: "token", token: "sk-ant-oat01-abc" }));
});

test("oauth without a refresh token is flagged; with one it's healthy", () => {
	assert.ok(classifySubscriptionRefresh({ type: "oauth", access: "a" }));
	assert.equal(classifySubscriptionRefresh({ type: "oauth", access: "a", refresh: "r" }), null);
	// A refresh stored as a ref also counts as healthy.
	assert.equal(classifySubscriptionRefresh({ type: "oauth", access: "a", refreshRef: { source: "env", id: "X" } }), null);
});

test("formatter lists each provider + the brigade login fix; empty → empty string", () => {
	const msg = formatUnrefreshableWarning([
		{ provider: "anthropic", label: "Claude Code", reason: "expired" },
	]);
	assert.match(msg, /Claude Code/);
	assert.match(msg, /brigade login/);
	assert.equal(formatUnrefreshableWarning([]), "");
});
