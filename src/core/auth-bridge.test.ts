/**
 * Fix 1 (bridge): `readBrigadeCredentials` is the OTHER credential entry point
 * (used by `loadBrigadeAuthStorage(agentId)`). Like the agent-loop builder it
 * must fall back to `main`'s credentials for a non-`main` agent's missing
 * providers, while a non-main agent's own key wins and `main` is unchanged.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { upsertApiKeyProfile } from "../auth/profiles.js";

let stateDir: string;
let prevState: string | undefined;
let prevAnthropic: string | undefined;
let prevOpenai: string | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "brigade-bridge-mainfb-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
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

describe("auth-bridge readBrigadeCredentials — main-agent fallback (Fix 1)", () => {
	it("a non-main agent with NO profile resolves main's anthropic key", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		const { readBrigadeCredentials } = await import("./auth-bridge.js");
		const creds = readBrigadeCredentials("eng-intern-1");
		assert.equal((creds.anthropic as { key?: string }).key, "sk-main-anthropic");
	});

	it("a non-main agent's own key wins over main's", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		upsertApiKeyProfile("eng-intern-1", { provider: "anthropic", key: "sk-intern-own" });
		const { readBrigadeCredentials } = await import("./auth-bridge.js");
		const creds = readBrigadeCredentials("eng-intern-1");
		assert.equal((creds.anthropic as { key?: string }).key, "sk-intern-own");
	});

	it("main itself never pulls from another agent", async () => {
		upsertApiKeyProfile(DEFAULT_AGENT_ID, { provider: "anthropic", key: "sk-main-anthropic" });
		const { readBrigadeCredentials } = await import("./auth-bridge.js");
		const creds = readBrigadeCredentials(DEFAULT_AGENT_ID);
		assert.equal((creds.anthropic as { key?: string }).key, "sk-main-anthropic");
		assert.equal(creds.openai, undefined);
	});
});
