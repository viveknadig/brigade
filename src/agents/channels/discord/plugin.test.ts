import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import type { ChannelAdapter, ChannelStartContext, InboundMessage, OutboundSendOptions } from "../../extensions/types.js";
import { addAllowFrom } from "../access-control/index.js";
import { listChannelApprovalDispatchers, resetChannelApprovalRouterForTests } from "../approval-router.js";
import { resetLastChannelRegistryForTests } from "../last-channel.js";
import { listDiscordAccountIds, resolveDiscordAccount, discordChannelEnabled } from "./account-config.js";
import { createDiscordPlugin } from "./plugin.js";

/** Build a fake adapter that records sends + exposes its start ctx. */
function makeFakeAdapter(accountId: string): {
	adapter: ChannelAdapter;
	ctx: () => ChannelStartContext;
	sent: { conversationId: string; text: string; opts?: OutboundSendOptions }[];
	stopped: () => boolean;
} {
	let ctx: ChannelStartContext | undefined;
	const sent: { conversationId: string; text: string; opts?: OutboundSendOptions }[] = [];
	let stopped = false;
	const adapter: ChannelAdapter = {
		id: "discord",
		label: "Discord",
		isConfigured: () => true,
		async start(c) {
			ctx = c;
		},
		async stop() {
			stopped = true;
		},
		async sendText(conversationId, text, opts) {
			sent.push({ conversationId, text, opts });
			return { messageId: String(sent.length) };
		},
		selfId: () => `self:${accountId}`,
		capabilities: { chatTypes: ["direct", "group", "thread"], edit: true, unsend: true, reactions: true, reply: true, nativeCommands: true },
		async handleAction() {
			return { ok: true, messageId: "ha-1" };
		},
	};
	return { adapter, ctx: () => ctx!, sent, stopped: () => stopped };
}

const cfgEmpty = {} as BrigadeConfig;
const cfgDisabled = { channels: { discord: { enabled: false } } } as unknown as BrigadeConfig;
const cfgLegacy = { channels: { discord: { enabled: true, botToken: "tok-AAA" } } } as unknown as BrigadeConfig;
const cfgMulti = {
	channels: {
		discord: {
			enabled: true,
			accounts: [
				{ id: "main", botToken: "tok-AAA" },
				{ id: "labs", botToken: "tok-BBB" },
			],
		},
	},
} as unknown as BrigadeConfig;

describe("Discord account-config (multi-account)", () => {
	it("listAccountIds is empty when Discord is disabled", () => {
		assert.deepEqual(listDiscordAccountIds(cfgEmpty), []);
		assert.deepEqual(listDiscordAccountIds(cfgDisabled), []);
	});

	it("legacy single-account configs surface ['default']", () => {
		assert.deepEqual(listDiscordAccountIds(cfgLegacy), ["default"]);
	});

	it("multi-account configs surface declared ids in order", () => {
		assert.deepEqual(listDiscordAccountIds(cfgMulti), ["main", "labs"]);
	});

	it("resolveAccount resolves per-account tokens", () => {
		assert.equal(resolveDiscordAccount(cfgMulti, "main").botToken, "tok-AAA");
		assert.equal(resolveDiscordAccount(cfgMulti, "labs").botToken, "tok-BBB");
	});

	it("discordChannelEnabled reads the enabled flag", () => {
		assert.equal(discordChannelEnabled(cfgLegacy), true);
		assert.equal(discordChannelEnabled(cfgDisabled), false);
	});
});

describe("createDiscordPlugin", () => {
	function makePlugin() {
		return createDiscordPlugin({
			defaultAgentId: "main",
			loadConfig: () => cfgMulti,
			runTurn: async () => ({ reply: "" }),
		});
	}

	it("declares the Discord meta + full capabilities (incl. nativeCommands)", () => {
		const plugin = makePlugin();
		assert.equal(plugin.id, "discord");
		assert.equal(plugin.meta.label, "Discord");
		assert.equal(plugin.capabilities.edit, true);
		assert.equal(plugin.capabilities.unsend, true);
		assert.equal(plugin.capabilities.nativeCommands, true);
	});

	it("listAccountIds returns the declared accounts via plugin.config", () => {
		const plugin = makePlugin();
		assert.deepEqual(plugin.config.listAccountIds(cfgMulti), ["main", "labs"]);
		assert.deepEqual(plugin.config.listAccountIds(cfgLegacy), ["default"]);
	});

	it("outbound.sendText refuses sends for an unstarted account", async () => {
		const plugin = makePlugin();
		const result = await plugin.outbound?.sendText?.({
			cfg: cfgMulti,
			runtime: {},
			target: { channel: "discord", to: "555", accountId: "main" },
			text: "hi",
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.match(result!.error ?? "", /not running/);
	});

	it("actions.handleAction refuses for an unstarted account", async () => {
		const plugin = makePlugin();
		const result = await plugin.actions?.handleAction?.({
			cfg: cfgMulti,
			runtime: {},
			accountId: "main",
			target: { channel: "discord", to: "555", accountId: "main" },
			action: { kind: "delete", messageId: "1" },
		});
		assert.ok(result);
		assert.equal(result!.ok, false);
		assert.match(result!.error ?? "", /cannot perform message actions/);
	});

	it("declares secret-target registry entries for the bot token", () => {
		const plugin = makePlugin();
		const paths = (plugin.secrets?.secretTargetRegistryEntries ?? []).map((e) => e.path);
		assert.ok(paths.includes("channels.discord.botToken"));
		assert.ok(paths.includes("channels.discord.accounts.*.botToken"));
	});
});

describe("createDiscordPlugin — multi-account lifecycle", () => {
	function withTempState<T>(fn: () => Promise<T>): Promise<T> {
		const tmp = mkdtempSync(join(tmpdir(), "brigade-discord-plugin-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = tmp;
		resetChannelApprovalRouterForTests();
		resetLastChannelRegistryForTests();
		return Promise.resolve(fn()).finally(() => {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			rmSync(tmp, { recursive: true, force: true });
			resetChannelApprovalRouterForTests();
			resetLastChannelRegistryForTests();
		});
	}

	type PluginRunTurn = Parameters<typeof createDiscordPlugin>[0]["runTurn"];
	function bootPlugin(opts: {
		cfg: BrigadeConfig;
		fakes: Map<string, ReturnType<typeof makeFakeAdapter>>;
		runTurn?: PluginRunTurn;
	}) {
		return createDiscordPlugin({
			defaultAgentId: "main",
			loadConfig: () => opts.cfg,
			runTurn: opts.runTurn ?? (async () => ({ reply: "" })),
			adapterFactory: ({ accountId }) => {
				const existing = opts.fakes.get(accountId);
				if (existing) return existing.adapter;
				const fake = makeFakeAdapter(accountId);
				opts.fakes.set(accountId, fake);
				return fake.adapter;
			},
		});
	}

	it("registers a per-account approval dispatcher on startAccount + drops it on stop", async () => {
		await withTempState(async () => {
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const plugin = bootPlugin({ cfg: cfgMulti, fakes });
			const startAccount = plugin.gateway?.startAccount;
			assert.ok(startAccount, "startAccount must exist");
			await startAccount!({ account: plugin.config.resolveAccount(cfgMulti, "main"), accountId: "main", cfg: cfgMulti, runtime: {}, signal: new AbortController().signal });
			await startAccount!({ account: plugin.config.resolveAccount(cfgMulti, "labs"), accountId: "labs", cfg: cfgMulti, runtime: {}, signal: new AbortController().signal });
			const keys = listChannelApprovalDispatchers();
			assert.ok(keys.includes("discord::main"), `main dispatcher must register: ${keys.join(",")}`);
			assert.ok(keys.includes("discord::labs"), `labs dispatcher must register: ${keys.join(",")}`);
			await plugin.gateway!.stopAccount!({ account: plugin.config.resolveAccount(cfgMulti, "labs"), accountId: "labs", cfg: cfgMulti, runtime: {}, signal: new AbortController().signal });
			const after = listChannelApprovalDispatchers();
			assert.ok(!after.includes("discord::labs"), `labs dispatcher must drop on stop: ${after.join(",")}`);
			assert.ok(after.includes("discord::main"), "main dispatcher must survive");
		});
	});

	it("allow-listed sender routes through pipeline + reply lands on the same account", async () => {
		await withTempState(async () => {
			addAllowFrom("discord", "999-friend", "main");
			const fakes = new Map<string, ReturnType<typeof makeFakeAdapter>>();
			const calls: { text: string; agentId: string }[] = [];
			const plugin = bootPlugin({
				cfg: cfgMulti,
				fakes,
				runTurn: async (a) => {
					calls.push({ text: a.text, agentId: a.agentId });
					return { reply: "pong from main" };
				},
			});
			await plugin.gateway!.startAccount!({ account: plugin.config.resolveAccount(cfgMulti, "main"), accountId: "main", cfg: cfgMulti, runtime: {}, signal: new AbortController().signal });
			const fake = fakes.get("main")!;
			await fake.ctx().onInbound({
				channel: "discord",
				conversationId: "999-friend",
				from: "999-friend",
				text: "ping",
				accountId: "main",
			});
			assert.equal(calls.length, 1, "approved sender must drive a turn");
			assert.deepEqual(
				fake.sent.map((s) => ({ to: s.conversationId, text: s.text, accountId: s.opts?.accountId })),
				[{ to: "999-friend", text: "pong from main", accountId: "main" }],
				"reply must land on the main account with accountId stamped",
			);
		});
	});
});
