import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import {
	listTelegramAccountIds,
	maskProxyUrl,
	resolveTelegramAccount,
	resolveTelegramBotToken,
	resolveTelegramProxyUrl,
	telegramChannelEnabled,
} from "./account-config.js";

// Pin the state dir to an EMPTY tempdir so the durable sealed-channel-token
// lookup inside `resolveTelegramBotToken` reads an empty credential store —
// these tests assert config/env resolution only, not the durable seal (which
// has its own coverage in the connect-channel reboot test). Without this, a
// real `~/.brigade` channel:telegram token on the dev machine would leak into
// the "no token configured" cases.
let prevStateDir: string | undefined;
let tmpStateDir: string;
before(() => {
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-tg-acct-"));
	process.env.BRIGADE_STATE_DIR = tmpStateDir;
});
after(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	try {
		fs.rmSync(tmpStateDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const cfg = (telegram: unknown): BrigadeConfig => ({ channels: { telegram } }) as unknown as BrigadeConfig;

describe("telegramChannelEnabled", () => {
	it("is true only when channels.telegram.enabled === true", () => {
		assert.equal(telegramChannelEnabled({} as BrigadeConfig), false);
		assert.equal(telegramChannelEnabled(cfg({})), false);
		assert.equal(telegramChannelEnabled(cfg({ enabled: false })), false);
		assert.equal(telegramChannelEnabled(cfg({ enabled: true })), true);
	});
});

describe("listTelegramAccountIds", () => {
	it("returns [] when disabled", () => {
		assert.deepEqual(listTelegramAccountIds(cfg({ enabled: false })), []);
	});

	it("legacy single-account config → [default]", () => {
		assert.deepEqual(listTelegramAccountIds(cfg({ enabled: true })), ["default"]);
		assert.deepEqual(listTelegramAccountIds(cfg({ enabled: true, botToken: "1:AAA" })), ["default"]);
	});

	it("multi-account config lists declared ids (deduped, trimmed)", () => {
		assert.deepEqual(
			listTelegramAccountIds(cfg({ enabled: true, accounts: [{ id: "main" }, { id: "ops" }, { id: "main" }] })),
			["main", "ops"],
		);
	});

	it("empty / malformed accounts[] still degrades to [default]", () => {
		assert.deepEqual(listTelegramAccountIds(cfg({ enabled: true, accounts: [] })), ["default"]);
		assert.deepEqual(listTelegramAccountIds(cfg({ enabled: true, accounts: [{}] })), ["default"]);
	});
});

describe("resolveTelegramBotToken", () => {
	it("reads a literal top-level botToken", () => {
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true, botToken: "123:ABC" }), "default", {}), "123:ABC");
	});

	it("resolves a ${VAR} ref against the supplied env", () => {
		const env = { MY_TG_TOKEN: "999:ZZZ" } as NodeJS.ProcessEnv;
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true, botToken: "${MY_TG_TOKEN}" }), "default", env), "999:ZZZ");
	});

	it("an unset ${VAR} ref resolves to empty string", () => {
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true, botToken: "${NOPE_UNSET}" }), "default", {}), "");
	});

	it("falls back to TELEGRAM_BOT_TOKEN env when no config token", () => {
		const env = { TELEGRAM_BOT_TOKEN: "env:TOKEN" } as NodeJS.ProcessEnv;
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true }), "default", env), "env:TOKEN");
	});

	it("config token wins over the env fallback", () => {
		const env = { TELEGRAM_BOT_TOKEN: "env:TOKEN" } as NodeJS.ProcessEnv;
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true, botToken: "cfg:TOKEN" }), "default", env), "cfg:TOKEN");
	});

	it("per-account botToken wins over top-level", () => {
		const c = cfg({ enabled: true, botToken: "top:LEVEL", accounts: [{ id: "ops", botToken: "ops:TOKEN" }] });
		assert.equal(resolveTelegramBotToken(c, "ops", {}), "ops:TOKEN");
		// Unknown account falls back to the top-level token.
		assert.equal(resolveTelegramBotToken(c, "missing", {}), "top:LEVEL");
	});

	it("returns empty string when nothing resolves", () => {
		assert.equal(resolveTelegramBotToken(cfg({ enabled: true }), "default", {}), "");
	});
});

describe("resolveTelegramAccount", () => {
	it("fills defaults + resolves the token", () => {
		const env = { TELEGRAM_BOT_TOKEN: "env:TOKEN" } as NodeJS.ProcessEnv;
		const r = resolveTelegramAccount(cfg({ enabled: true, verbose: true }), undefined, env);
		assert.equal(r.accountId, "default");
		assert.equal(r.enabled, true);
		assert.equal(r.botToken, "env:TOKEN");
		assert.equal(r.verbose, true);
	});

	it("reports disabled when an account entry sets enabled:false", () => {
		const c = cfg({ enabled: true, accounts: [{ id: "ops", enabled: false, botToken: "x:y" }] });
		assert.equal(resolveTelegramAccount(c, "ops", {}).enabled, false);
	});

	it("resolves the proxy url onto the resolved account", () => {
		const c = cfg({ enabled: true, proxy: "http://proxy.local:8080" });
		assert.equal(resolveTelegramAccount(c, "default", {}).proxyUrl, "http://proxy.local:8080");
	});
});

describe("resolveTelegramProxyUrl", () => {
	it("returns '' when no proxy is configured anywhere (direct connection)", () => {
		assert.equal(resolveTelegramProxyUrl(cfg({ enabled: true }), "default", {}), "");
	});

	it("uses the top-level channels.telegram.proxy", () => {
		const c = cfg({ enabled: true, proxy: "http://top.proxy:3128" });
		assert.equal(resolveTelegramProxyUrl(c, "default", {}), "http://top.proxy:3128");
	});

	it("resolves a ${VAR} ref against env (like botToken)", () => {
		const c = cfg({ enabled: true, proxy: "${TG_PROXY}" });
		assert.equal(resolveTelegramProxyUrl(c, "default", { TG_PROXY: "http://ref.proxy:8080" } as NodeJS.ProcessEnv), "http://ref.proxy:8080");
	});

	it("per-account proxy overrides the top-level proxy", () => {
		const c = cfg({
			enabled: true,
			proxy: "http://top.proxy:3128",
			accounts: [{ id: "ops", botToken: "o:t", proxy: "http://ops.proxy:9000" }],
		});
		assert.equal(resolveTelegramProxyUrl(c, "ops", {}), "http://ops.proxy:9000");
		// An account WITHOUT its own proxy inherits the top-level one.
		const c2 = cfg({ enabled: true, proxy: "http://top.proxy:3128", accounts: [{ id: "ops2", botToken: "o:t" }] });
		assert.equal(resolveTelegramProxyUrl(c2, "ops2", {}), "http://top.proxy:3128");
	});

	it("env fallback precedence: https_proxy > HTTPS_PROXY > all_proxy > ALL_PROXY", () => {
		const base = cfg({ enabled: true });
		assert.equal(resolveTelegramProxyUrl(base, "default", { ALL_PROXY: "http://all-up:1" } as NodeJS.ProcessEnv), "http://all-up:1");
		assert.equal(
			resolveTelegramProxyUrl(base, "default", { ALL_PROXY: "http://all-up:1", all_proxy: "http://all-lo:2" } as NodeJS.ProcessEnv),
			"http://all-lo:2",
		);
		assert.equal(
			resolveTelegramProxyUrl(base, "default", { all_proxy: "http://all-lo:2", HTTPS_PROXY: "http://https-up:3" } as NodeJS.ProcessEnv),
			"http://https-up:3",
		);
		assert.equal(
			resolveTelegramProxyUrl(base, "default", { HTTPS_PROXY: "http://https-up:3", https_proxy: "http://https-lo:4" } as NodeJS.ProcessEnv),
			"http://https-lo:4",
		);
	});

	it("config proxy outranks the env fallback", () => {
		const c = cfg({ enabled: true, proxy: "http://cfg.proxy:8080" });
		assert.equal(resolveTelegramProxyUrl(c, "default", { HTTPS_PROXY: "http://env.proxy:3128" } as NodeJS.ProcessEnv), "http://cfg.proxy:8080");
	});
});

describe("maskProxyUrl", () => {
	it("reduces to scheme://host:port and DROPS credentials", () => {
		assert.equal(maskProxyUrl("http://user:pass@proxy.local:8080/path?q=1"), "http://proxy.local:8080");
		assert.equal(maskProxyUrl("https://proxy.local:3128"), "https://proxy.local:3128");
	});

	it("returns '' for empty input and masks a malformed url to its scheme", () => {
		assert.equal(maskProxyUrl(""), "");
		assert.equal(maskProxyUrl("   "), "");
		assert.equal(maskProxyUrl("socks5://not a url with spaces"), "socks5://<masked>");
		assert.equal(maskProxyUrl("garbage"), "<masked>");
	});
});
