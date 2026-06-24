/**
 * `discord_action` tool — dispatch + ownerOnly + Discord-config gating (Phase 4).
 *
 * Tempdir-isolated (never reads the operator's real ~/.brigade or hits the
 * network). Covers:
 *   - each action dispatches to the right REST helper (asserted via a recording
 *     fetch's METHOD + PATH);
 *   - `ownerOnly` is set on the tool;
 *   - the tool is only ASSEMBLED by the registry when Discord is configured;
 *   - a malformed / missing-param action fails cleanly (no throw, ok:false).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { capDiscordData, makeDiscordActionTool } from "./discord-action-tool.js";

/** Recording fake fetch — captures the call + returns a canned 2xx response. */
function recordFetch(opts?: { route?: (url: string) => { ok: boolean; status: number; json: unknown } | undefined }): {
	fetch: typeof fetch;
	calls: Array<{ url: string; method: string }>;
} {
	const calls: Array<{ url: string; method: string }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET" });
		const routed = opts?.route?.(url);
		if (routed) return { ok: routed.ok, status: routed.status, json: async () => routed.json } as Response;
		return { ok: true, status: 200, json: async () => ({ id: "x" }) } as Response;
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** Run an action with an injected token + recording fetch; returns parsed details. */
async function run(
	args: Record<string, unknown>,
	rec = recordFetch(),
): Promise<{ details: { action: string; ok: boolean; message: string }; calls: typeof rec.calls }> {
	const tool = makeDiscordActionTool({ resolveToken: () => "TESTTOKEN", fetchImpl: rec.fetch });
	const res = (await tool.execute("call-1", args as never)) as {
		details: { action: string; ok: boolean; message: string };
	};
	return { details: res.details, calls: rec.calls };
}

describe("discord_action — tool shape", () => {
	it("is ownerOnly with the right name", () => {
		const tool = makeDiscordActionTool();
		assert.equal(tool.name, "discord_action");
		assert.equal(tool.ownerOnly, true);
	});

	it("fails cleanly (ok:false, no throw) when no token is configured", async () => {
		const tool = makeDiscordActionTool({ resolveToken: () => "" });
		const res = (await tool.execute("c", { action: "role-list", guildId: "g1" } as never)) as {
			details: { ok: boolean; message: string };
		};
		assert.equal(res.details.ok, false);
		assert.match(res.details.message, /no Discord bot token|configured/i);
	});
});

describe("discord_action — dispatch to the right helper", () => {
	const cases: Array<{ name: string; args: Record<string, unknown>; method: string; pathRe: RegExp }> = [
		{ name: "send", args: { action: "send", to: "555", content: "hi" }, method: "POST", pathRe: /\/channels\/555\/messages$/ },
		{
			name: "send-embed",
			args: { action: "send-embed", to: "555", embed: { title: "T" } },
			method: "POST",
			pathRe: /\/channels\/555\/messages$/,
		},
		{ name: "read-messages", args: { action: "read-messages", channelId: "555" }, method: "GET", pathRe: /\/channels\/555\/messages/ },
		{
			name: "channel-create",
			args: { action: "channel-create", guildId: "g1", name: "general" },
			method: "POST",
			pathRe: /\/guilds\/g1\/channels$/,
		},
		{
			name: "role-add",
			args: { action: "role-add", guildId: "g1", userId: "u1", roleId: "r1" },
			method: "PUT",
			pathRe: /\/guilds\/g1\/members\/u1\/roles\/r1$/,
		},
		{ name: "member-info", args: { action: "member-info", guildId: "g1", userId: "u1" }, method: "GET", pathRe: /\/guilds\/g1\/members\/u1$/ },
		{ name: "ban", args: { action: "ban", guildId: "g1", userId: "u1" }, method: "PUT", pathRe: /\/guilds\/g1\/bans\/u1$/ },
		{ name: "kick", args: { action: "kick", guildId: "g1", userId: "u1" }, method: "DELETE", pathRe: /\/guilds\/g1\/members\/u1$/ },
		{
			name: "timeout",
			args: { action: "timeout", guildId: "g1", userId: "u1", durationMinutes: 5 },
			method: "PATCH",
			pathRe: /\/guilds\/g1\/members\/u1$/,
		},
		{ name: "event-list", args: { action: "event-list", guildId: "g1" }, method: "GET", pathRe: /\/guilds\/g1\/scheduled-events$/ },
	];

	for (const c of cases) {
		it(`${c.name} → ${c.method} ${c.pathRe}`, async () => {
			const { details, calls } = await run(c.args);
			assert.equal(details.ok, true, `${c.name} should succeed: ${details.message}`);
			// The LAST call is the action itself (some, e.g. user: DMs, prefix with a lookup).
			const call = calls[calls.length - 1]!;
			assert.equal(call.method, c.method, `${c.name} method`);
			assert.match(call.url, c.pathRe, `${c.name} path`);
		});
	}

	it("poll posts to the channel messages endpoint with a poll body", async () => {
		const { details, calls } = await run({ action: "poll", to: "555", question: "Q", answers: ["A", "B"] });
		assert.equal(details.ok, true);
		assert.match(calls[calls.length - 1]!.url, /\/channels\/555\/messages$/);
	});
});

describe("discord_action — required-param refusals", () => {
	it("send without `to` fails cleanly", async () => {
		const { details, calls } = await run({ action: "send", content: "hi" });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires `to`/);
		assert.equal(calls.length, 0, "no REST call on a param refusal");
	});

	it("ban without `userId` fails cleanly", async () => {
		const { details } = await run({ action: "ban", guildId: "g1" });
		assert.equal(details.ok, false);
		assert.match(details.message, /requires `userId`/);
	});

	it("timeout without durationMinutes fails cleanly", async () => {
		const { details } = await run({ action: "timeout", guildId: "g1", userId: "u1" });
		assert.equal(details.ok, false);
		assert.match(details.message, /durationMinutes/);
	});

	it("a 50013 permission error surfaces a decoded operator-readable message", async () => {
		const rec = recordFetch({ route: () => ({ ok: false, status: 403, json: { code: 50013, message: "Missing Permissions" } }) });
		const { details } = await run({ action: "ban", guildId: "g1", userId: "u1" }, rec);
		assert.equal(details.ok, false);
		assert.match(details.message, /lacks the permission/i);
	});
});

describe("discord_action — capDiscordData", () => {
	it("passes small payloads through untouched", () => {
		assert.deepEqual(capDiscordData({ a: 1 }), { a: 1 });
	});
	it("truncates oversized payloads", () => {
		const big = "x".repeat(20_000);
		const out = capDiscordData({ big }) as { truncated?: boolean };
		assert.equal(out.truncated, true);
	});
});

/* ─────────────── registry gating: only assembled when Discord is configured ─────────────── */

describe("discord_action — registry assembly gate", () => {
	let stateDir: string;
	let cfgPath: string;
	const prevConfigPath = process.env.BRIGADE_CONFIG_PATH;
	const prevComposio = process.env.COMPOSIO_API_KEY;

	before(() => {
		stateDir = mkdtempSync(join(tmpdir(), "brigade-discord-gate-"));
		cfgPath = join(stateDir, "brigade.json");
		// Neutralize a shell Composio key so it can't perturb assembly elsewhere.
		delete process.env.COMPOSIO_API_KEY;
	});

	after(() => {
		if (prevConfigPath === undefined) delete process.env.BRIGADE_CONFIG_PATH;
		else process.env.BRIGADE_CONFIG_PATH = prevConfigPath;
		if (prevComposio !== undefined) process.env.COMPOSIO_API_KEY = prevComposio;
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	/** Assemble the registry's tool names against a given brigade.json. */
	async function toolNamesForConfig(config: unknown): Promise<string[]> {
		writeFileSync(cfgPath, JSON.stringify(config), "utf8");
		process.env.BRIGADE_CONFIG_PATH = cfgPath;
		const { createBrigadeTools } = await import("./registry.js");
		const tools = createBrigadeTools({ workspaceDir: stateDir, agentId: "main", cwd: stateDir });
		return tools.map((t) => t.name);
	}

	it("is NOT assembled when Discord is disabled / unconfigured", async () => {
		const names = await toolNamesForConfig({ agents: {} });
		assert.equal(names.includes("discord_action"), false);
	});

	it("IS assembled when channels.discord.enabled is true", async () => {
		const names = await toolNamesForConfig({
			agents: {},
			channels: { discord: { enabled: true, botToken: "AAA" } },
		});
		assert.equal(names.includes("discord_action"), true);
	});
});
