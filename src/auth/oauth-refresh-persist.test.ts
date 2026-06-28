/**
 * OAuth refresh persistence — `updateOAuthTokens` is the write-back path that
 * lets Pi's auto-refresh survive a gateway restart. Every subscription provider
 * ROTATES its refresh token on each refresh, so the rotated token MUST land on
 * disk; otherwise the next boot re-reads the stale (now-invalid) refresh token
 * and every turn 401s. These tests lock the in-place, non-destructive update.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { initAuthProfiles, readProfiles, updateOAuthTokens, upsertOAuthProfile } from "./profiles.js";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "brigade-oauth-persist-"));
	prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
	initAuthProfiles("main");
});

afterEach(() => {
	if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

test("rotates access/refresh/expires in place, preserving clientSecret + metadata", () => {
	upsertOAuthProfile("main", {
		provider: "anthropic",
		access: "old-access",
		refresh: "old-refresh",
		expires: 1000,
		clientSecret: "shh-secret",
		metadata: { accountId: "acct-1" },
	});

	const changed = updateOAuthTokens("main", "anthropic", {
		access: "new-access",
		refresh: "rotated-refresh",
		expires: 9999,
	});
	assert.equal(changed, true);

	const prof = readProfiles("main").profiles["anthropic:default"]!;
	assert.equal(prof.type, "oauth");
	assert.equal(prof.access, "new-access");
	assert.equal(prof.refresh, "rotated-refresh");
	assert.equal(prof.expires, 9999);
	// The sealed clientSecret (`key`) and metadata survive a token rotation.
	assert.equal(prof.key, "shh-secret");
	assert.deepEqual(prof.metadata, { accountId: "acct-1" });
});

test("returns false when no oauth profile exists for the provider (nothing to rotate)", () => {
	// An api_key profile is not an oauth profile — the write-back is a no-op.
	upsertOAuthProfile("main", { provider: "anthropic", access: "a", refresh: "r", expires: 1 });
	assert.equal(updateOAuthTokens("main", "openai", { access: "x", refresh: "y" }), false);
});

test("merges metadata rather than replacing it; untouched fields stay put", () => {
	upsertOAuthProfile("main", {
		provider: "openai-codex",
		access: "a0",
		refresh: "r0",
		expires: 1,
		metadata: { accountId: "acct", region: "us" },
	});

	updateOAuthTokens("main", "openai-codex", { access: "a1", metadata: { region: "eu" } });

	const prof = readProfiles("main").profiles["openai-codex:default"]!;
	assert.equal(prof.access, "a1");
	assert.equal(prof.refresh, "r0"); // not passed → unchanged
	assert.equal(prof.expires, 1); // not passed → unchanged
	assert.deepEqual(prof.metadata, { accountId: "acct", region: "eu" });
});
