/**
 * C5: agent-loop's credential map must env-fallback for known providers
 * when no auth-profiles.json entry exists. Without this, a fresh agent +
 * `ANTHROPIC_API_KEY` shell var produces a 401 because the per-turn
 * credential builder hands Pi an empty map.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

let stateDir: string;
let prevState: string | undefined;
let prevKey: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "brigade-auth-envfb-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	prevKey = process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = prevKey;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agent-loop readAuthProfilesAsCredentialMap (C5)", () => {
	it("falls back to ANTHROPIC_API_KEY env var when no auth-profiles.json exists", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-env-fallback";
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const missingPath = path.join(stateDir, "does-not-exist-auth-profiles.json");
		const { credentials } = readAuthProfilesAsCredentialMap(missingPath);
		const anthropic = credentials.anthropic as { type?: string; key?: string } | undefined;
		assert.equal(anthropic?.type, "api_key");
		assert.equal(anthropic?.key, "sk-test-env-fallback");
	});

	it("returns empty when neither file nor env vars are present", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const missingPath = path.join(stateDir, "missing.json");
		const { credentials } = readAuthProfilesAsCredentialMap(missingPath);
		assert.equal(credentials.anthropic, undefined);
		assert.equal(credentials.openai, undefined);
	});
});
