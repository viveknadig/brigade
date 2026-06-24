/**
 * Fix 1: a non-`main` agent (org agents like `eng-intern-1`, `ceo`, …) has no
 * auth profile of its own and the env fallback is dead in convex mode — so its
 * per-turn credential map would be EMPTY and the run fails with "No API key
 * found for anthropic". `readAuthProfilesAsCredentialMap` must fall back to
 * `main`'s credentials for any provider the non-main agent lacks, while a
 * non-main agent with its OWN explicit key for a provider keeps it (override
 * wins), and `main` itself is unchanged.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_AGENT_ID, resolveAuthProfilesPath } from "../config/paths.js";
import { upsertApiKeyProfile } from "../auth/profiles.js";

let stateDir: string;
let prevState: string | undefined;
let prevAnthropic: string | undefined;
let prevOpenai: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "brigade-auth-mainfb-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	// The env fallback would otherwise mask the main-fallback under test.
	prevAnthropic = process.env.ANTHROPIC_API_KEY;
	prevOpenai = process.env.OPENAI_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = prevAnthropic;
	if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = prevOpenai;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("agent-loop readAuthProfilesAsCredentialMap — main-agent fallback (Fix 1)", () => {
	it("a non-main agent with NO profile resolves main's anthropic key", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const internPath = resolveAuthProfilesPath("eng-intern-1");
		const { credentials } = readAuthProfilesAsCredentialMap(internPath, undefined, "eng-intern-1");
		const anthropic = credentials.anthropic as { type?: string; key?: string } | undefined;
		assert.equal(anthropic?.type, "api_key");
		assert.equal(anthropic?.key, "sk-main-anthropic", "intern inherits main's anthropic key");
	});

	it("a non-main agent with its OWN key for a provider keeps its own (override wins)", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		upsertApiKeyProfile("eng-intern-1", { provider: "anthropic", key: "sk-intern-own" });
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const internPath = resolveAuthProfilesPath("eng-intern-1");
		const { credentials } = readAuthProfilesAsCredentialMap(internPath, undefined, "eng-intern-1");
		const anthropic = credentials.anthropic as { key?: string } | undefined;
		assert.equal(anthropic?.key, "sk-intern-own", "intern's own key wins over main's");
	});

	it("a non-main agent inherits main per-provider: own openai + main's anthropic", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		upsertApiKeyProfile("eng-intern-1", { provider: "openai", key: "sk-intern-openai" });
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const internPath = resolveAuthProfilesPath("eng-intern-1");
		const { credentials } = readAuthProfilesAsCredentialMap(internPath, undefined, "eng-intern-1");
		assert.equal((credentials.openai as { key?: string }).key, "sk-intern-openai");
		assert.equal((credentials.anthropic as { key?: string }).key, "sk-main-anthropic");
	});

	it("main itself is unchanged — never pulls from another agent", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		const { readAuthProfilesAsCredentialMap } = await import("./agent-loop.js");
		const mainPath = resolveAuthProfilesPath(DEFAULT_AGENT_ID);
		const { credentials } = readAuthProfilesAsCredentialMap(mainPath, undefined, DEFAULT_AGENT_ID);
		assert.equal((credentials.anthropic as { key?: string }).key, "sk-main-anthropic");
		// Only the one provider main actually has.
		assert.equal(credentials.openai, undefined);
	});
});
