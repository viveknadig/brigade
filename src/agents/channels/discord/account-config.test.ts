import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import {
	discordChannelEnabled,
	discordThreadIdleTtlMs,
	listDiscordAccountIds,
	maskProxyUrl,
	resolveDiscordAccount,
	resolveDiscordBotToken,
	resolveDiscordProxyUrl,
	stripBotPrefix,
} from "./account-config.js";

const cfg = (discord: Record<string, unknown>): BrigadeConfig => ({ channels: { discord } }) as unknown as BrigadeConfig;
const noEnv: NodeJS.ProcessEnv = {};

describe("discord account-config — enable + account ids", () => {
	it("disabled / missing → no accounts", () => {
		assert.equal(discordChannelEnabled(cfg({})), false);
		assert.deepEqual(listDiscordAccountIds(cfg({})), []);
		assert.deepEqual(listDiscordAccountIds(cfg({ enabled: false })), []);
	});

	it("legacy single-account → ['default']", () => {
		assert.equal(discordChannelEnabled(cfg({ enabled: true })), true);
		assert.deepEqual(listDiscordAccountIds(cfg({ enabled: true, botToken: "tok-A" })), ["default"]);
	});

	it("multi-account → the configured ids (deduped)", () => {
		assert.deepEqual(
			listDiscordAccountIds(cfg({ enabled: true, accounts: [{ id: "main" }, { id: "labs" }, { id: "main" }] })),
			["main", "labs"],
		);
	});

	it("an empty accounts[] degrades to ['default']", () => {
		assert.deepEqual(listDiscordAccountIds(cfg({ enabled: true, accounts: [] })), ["default"]);
	});
});

describe("discord account-config — token resolution", () => {
	it("resolves the top-level literal token", () => {
		const c = cfg({ enabled: true, botToken: "tok-A" });
		assert.equal(resolveDiscordBotToken(c, "default", noEnv), "tok-A");
	});

	it("per-account token overrides the top-level token", () => {
		const c = cfg({ enabled: true, botToken: "tok-top", accounts: [{ id: "main", botToken: "tok-main" }] });
		assert.equal(resolveDiscordBotToken(c, "main", noEnv), "tok-main");
	});

	it("${VAR} refs resolve against env", () => {
		const c = cfg({ enabled: true, botToken: "${DISCORD_BOT_TOKEN}" });
		const env = { DISCORD_BOT_TOKEN: "tok-env" } as NodeJS.ProcessEnv;
		assert.equal(resolveDiscordBotToken(c, "default", env), "tok-env");
	});

	it("env var is the last-resort fallback", () => {
		const c = cfg({ enabled: true });
		const env = { DISCORD_BOT_TOKEN: "tok-fallback" } as NodeJS.ProcessEnv;
		assert.equal(resolveDiscordBotToken(c, "default", env), "tok-fallback");
	});

	it("strips a leading `Bot ` scheme prefix from every source", () => {
		assert.equal(resolveDiscordBotToken(cfg({ enabled: true, botToken: "Bot tok-A" }), "default", noEnv), "tok-A");
		assert.equal(stripBotPrefix("Bot   tok-x"), "tok-x");
		assert.equal(stripBotPrefix("bot tok-y"), "tok-y");
		assert.equal(stripBotPrefix("tok-z"), "tok-z");
	});

	it("resolveDiscordAccount bundles the token + enabled flag", () => {
		const c = cfg({ enabled: true, botToken: "tok-A" });
		const acct = resolveDiscordAccount(c, "default", noEnv);
		assert.equal(acct.accountId, "default");
		assert.equal(acct.enabled, true);
		assert.equal(acct.botToken, "tok-A");
	});

	it("a per-account enabled:false disables that account", () => {
		const c = cfg({ enabled: true, accounts: [{ id: "main", enabled: false, botToken: "tok-A" }] });
		assert.equal(resolveDiscordAccount(c, "main", noEnv).enabled, false);
	});
});

describe("discord account-config — thread idle ttl", () => {
	it("parses duration strings + raw numbers, else null", () => {
		assert.equal(discordThreadIdleTtlMs(cfg({ enabled: true, threadIdleTtlMs: "6h" })), 6 * 3_600_000);
		assert.equal(discordThreadIdleTtlMs(cfg({ enabled: true, threadIdleTtlMs: 5000 })), 5000);
		assert.equal(discordThreadIdleTtlMs(cfg({ enabled: true })), null);
	});
});

describe("discord account-config — proxy resolution", () => {
	it("returns '' (direct) when no proxy is configured", () => {
		assert.equal(resolveDiscordProxyUrl(cfg({ enabled: true }), "default", noEnv), "");
	});

	it("reads the top-level proxy", () => {
		assert.equal(
			resolveDiscordProxyUrl(cfg({ enabled: true, proxy: "http://p.local:8080" }), "default", noEnv),
			"http://p.local:8080",
		);
	});

	it("per-account proxy overrides the top-level one", () => {
		const c = cfg({
			enabled: true,
			proxy: "http://top:8080",
			accounts: [{ id: "main", proxy: "socks5://main:1080" }],
		});
		assert.equal(resolveDiscordProxyUrl(c, "main", noEnv), "socks5://main:1080");
	});

	it("resolves a ${VAR} ref against env", () => {
		const c = cfg({ enabled: true, proxy: "${DISCORD_PROXY}" });
		assert.equal(resolveDiscordProxyUrl(c, "default", { DISCORD_PROXY: "http://env:3128" }), "http://env:3128");
	});

	it("falls back to standard proxy env vars (https_proxy / ALL_PROXY)", () => {
		assert.equal(resolveDiscordProxyUrl(cfg({ enabled: true }), "default", { HTTPS_PROXY: "http://envp:8080" }), "http://envp:8080");
		assert.equal(resolveDiscordProxyUrl(cfg({ enabled: true }), "default", { ALL_PROXY: "socks5://envs:1080" }), "socks5://envs:1080");
	});

	it("resolveDiscordAccount surfaces the resolved proxyUrl", () => {
		const c = cfg({ enabled: true, proxy: "http://p:8080" });
		assert.equal(resolveDiscordAccount(c, "default", noEnv).proxyUrl, "http://p:8080");
	});

	it("maskProxyUrl drops credentials + path for safe logging", () => {
		assert.equal(maskProxyUrl("http://user:pass@p.local:8080/path"), "http://p.local:8080");
		assert.equal(maskProxyUrl(""), "");
		assert.equal(maskProxyUrl("not a url"), "<masked>");
	});
});
