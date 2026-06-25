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

	it("sticker-upload POSTs the guild stickers endpoint (multipart) — Fix 6", async () => {
		// A 1px PNG data URI → decoded to bytes and uploaded as multipart/form-data.
		const png =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const { details, calls } = await run({
			action: "sticker-upload",
			guildId: "g1",
			stickerName: "blob",
			stickerDescription: "a blob",
			stickerTags: "blob",
			stickerImage: png,
		});
		assert.equal(details.ok, true, `sticker-upload should succeed: ${details.message}`);
		const call = calls[calls.length - 1]!;
		assert.equal(call.method, "POST");
		assert.match(call.url, /\/guilds\/g1\/stickers$/);
	});

	it("sticker-upload rejects a non-data-URI image cleanly (ok:false, no throw)", async () => {
		const { details } = await run({
			action: "sticker-upload",
			guildId: "g1",
			stickerName: "blob",
			stickerTags: "blob",
			stickerImage: "not-a-data-uri",
		});
		assert.equal(details.ok, false);
		assert.match(details.message, /data URI|base64/i);
	});
});

/* ─────────────── typed interactive components (Fix A1) ─────────────── */

/** Fetch stub that captures the parsed JSON body of each call. */
function recordFetchWithBody(): {
	fetch: typeof fetch;
	calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }>;
} {
	const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
		});
		return { ok: true, status: 200, json: async () => ({ id: "m1" }) } as Response;
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

async function runWithBody(
	args: Record<string, unknown>,
): Promise<{ details: { ok: boolean; message: string }; calls: ReturnType<typeof recordFetchWithBody>["calls"] }> {
	const rec = recordFetchWithBody();
	const tool = makeDiscordActionTool({ resolveToken: () => "TESTTOKEN", fetchImpl: rec.fetch });
	const res = (await tool.execute("c", args as never)) as { details: { ok: boolean; message: string } };
	return { details: res.details, calls: rec.calls };
}

describe("discord_action — typed interactive components (Fix A1)", () => {
	it("send with a `select` spec posts a string-select action row with a general-prefixed custom_id", async () => {
		const { details, calls } = await runWithBody({
			action: "send",
			to: "555",
			content: "pick one",
			select: { kind: "string", customId: "pick", options: [{ label: "A", value: "a" }] },
		});
		assert.equal(details.ok, true, details.message);
		const body = calls[calls.length - 1]!.body!;
		const rows = body.components as Array<Record<string, unknown>>;
		assert.equal(rows.length, 1, "one component row");
		assert.equal(rows[0]!.type, 1, "action row");
		const select = (rows[0]!.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(select.type, 3, "string select");
		// The custom_id is general-prefixed so the press-router decodes it.
		assert.match(String(select.custom_id), /^g:/, "general-prefixed custom_id");
	});

	it("an emitted select's custom_id is one the press-router decodes", async () => {
		const { calls } = await runWithBody({
			action: "send",
			to: "555",
			select: { kind: "string", customId: "color", options: [{ label: "Red", value: "r" }] },
		});
		const body = calls[calls.length - 1]!.body!;
		const select = ((body.components as Array<Record<string, unknown>>)[0]!.components as Array<Record<string, unknown>>)[0]!;
		const customId = String(select.custom_id);
		// The connection's select branch surfaces values via the general callback codec.
		const { isGeneralCallbackData, decodeGeneralCallbackData } = await import("../channels/general-callback.js");
		assert.ok(isGeneralCallbackData(customId), "router recognizes it as a general callback");
		assert.equal(decodeGeneralCallbackData(customId), "color");
	});

	it("send with a `modal` spec registers an entry + emits a modal:<id> trigger button", async () => {
		const { __resetDiscordModalRegistryForTest, getDiscordModal } = await import("../channels/discord/modal-registry.js");
		const { decodeDiscordModalCustomId } = await import("../channels/discord/modals.js");
		__resetDiscordModalRegistryForTest();
		try {
			const { details, calls } = await runWithBody({
				action: "send",
				to: "555",
				content: "fill this in",
				modal: { buttonLabel: "Open form", title: "Form", fields: [{ id: "name", label: "Name" }] },
			});
			assert.equal(details.ok, true, details.message);
			const body = calls[calls.length - 1]!.body!;
			const button = ((body.components as Array<Record<string, unknown>>)[0]!.components as Array<Record<string, unknown>>)[0]!;
			assert.equal(button.type, 2, "button");
			const customId = String(button.custom_id);
			assert.match(customId, /^modal:/, "modal trigger marker");
			const modalId = decodeDiscordModalCustomId(customId);
			assert.ok(getDiscordModal(modalId), "modal entry registered for the marker");
		} finally {
			__resetDiscordModalRegistryForTest();
		}
	});

	it("send with `blocks` sets the IsComponentsV2 flag + a container, and drops plain content", async () => {
		const { details, calls } = await runWithBody({
			action: "send",
			to: "555",
			blocks: { blocks: [{ type: "text", text: "V2 hello" }] },
		});
		assert.equal(details.ok, true, details.message);
		const body = calls[calls.length - 1]!.body!;
		assert.equal(body.flags, 1 << 15, "IsComponentsV2 flag set");
		assert.equal(body.content, undefined, "no plain content on a V2 message");
		const container = (body.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(container.type, 17, "container");
		const text = (container.components as Array<Record<string, unknown>>)[0]!;
		assert.equal(text.type, 10, "text moved into a TextDisplay block");
		assert.equal(text.content, "V2 hello");
	});

	it("rejects combining blocks (V2) with content/embeds/select in one send", async () => {
		const { details, calls } = await runWithBody({
			action: "send",
			to: "555",
			content: "classic",
			blocks: { blocks: [{ type: "text", text: "v2" }] },
		});
		assert.equal(details.ok, false);
		assert.match(details.message, /cannot be combined/i);
		assert.equal(calls.length, 0, "no REST call when the combo is rejected");
	});

	it("fails cleanly on an unusable select spec (string select with no option)", async () => {
		const { details, calls } = await runWithBody({
			action: "send",
			to: "555",
			content: "x",
			select: { kind: "string", customId: "p", options: [] },
		});
		assert.equal(details.ok, false);
		assert.match(details.message, /option/i);
		assert.equal(calls.length, 0, "no REST call on a bad spec");
	});

	it("still supports the raw components passthrough for power users", async () => {
		const { details, calls } = await runWithBody({
			action: "send",
			to: "555",
			components: [{ type: 1, components: [{ type: 2, style: 2, label: "Raw", custom_id: "raw1" }] }],
		});
		assert.equal(details.ok, true, details.message);
		const body = calls[calls.length - 1]!.body!;
		const rows = body.components as Array<Record<string, unknown>>;
		assert.equal((rows[0]!.components as Array<Record<string, unknown>>)[0]!.custom_id, "raw1");
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

describe("discord_action — set-presence (Phase 5)", () => {
	it("persists channels.discord.presence and reports success", async () => {
		let written: unknown;
		const tool = makeDiscordActionTool({
			resolveToken: () => "TESTTOKEN",
			mutateConfig: async (m) => {
				written = m({ channels: { discord: { enabled: true } } } as never);
				return written as never;
			},
		});
		const res = (await tool.execute("c", {
			action: "set-presence",
			status: "dnd",
			activityType: "watching",
			activityText: "the logs",
		} as never)) as { details: { ok: boolean; message: string; data?: unknown } };
		assert.equal(res.details.ok, true);
		assert.match(res.details.message, /next \(re\)connect/);
		const presence = (written as { channels: { discord: { presence?: Record<string, unknown> } } }).channels.discord.presence;
		assert.deepEqual(presence, { status: "dnd", activityType: "watching", activityText: "the logs" });
	});

	it("streaming presence keeps the url", async () => {
		let written: unknown;
		const tool = makeDiscordActionTool({
			resolveToken: () => "TESTTOKEN",
			mutateConfig: async (m) => {
				written = m({ channels: { discord: { enabled: true } } } as never);
				return written as never;
			},
		});
		await tool.execute("c", {
			action: "set-presence",
			activityType: "streaming",
			activityText: "live",
			activityUrl: "https://twitch.tv/x",
		} as never);
		const presence = (written as { channels: { discord: { presence?: Record<string, unknown> } } }).channels.discord.presence;
		assert.equal(presence?.activityUrl, "https://twitch.tv/x");
	});

	it("writes per-account presence when the account exists in accounts[]", async () => {
		let written: unknown;
		const tool = makeDiscordActionTool({
			resolveToken: () => "TESTTOKEN",
			mutateConfig: async (m) => {
				written = m({
					channels: { discord: { enabled: true, accounts: [{ id: "labs", botToken: "x" }] } },
				} as never);
				return written as never;
			},
		});
		await tool.execute("c", { action: "set-presence", accountId: "labs", status: "idle" } as never);
		const accounts = (written as { channels: { discord: { accounts: Array<{ id: string; presence?: unknown }> } } }).channels.discord.accounts;
		assert.deepEqual(accounts[0]?.presence, { status: "idle" });
	});

	it("fails cleanly when nothing to set", async () => {
		const tool = makeDiscordActionTool({ resolveToken: () => "TESTTOKEN", mutateConfig: async (m) => m({} as never) });
		const res = (await tool.execute("c", { action: "set-presence" } as never)) as { details: { ok: boolean; message: string } };
		assert.equal(res.details.ok, false);
		assert.match(res.details.message, /requires at least/);
	});
});
