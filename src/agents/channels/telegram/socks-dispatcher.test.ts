import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildSocksDispatcher, isSocksProxyScheme } from "./socks-dispatcher.js";

describe("isSocksProxyScheme", () => {
	it("recognises every SOCKS scheme", () => {
		for (const s of ["socks", "socks4", "socks4a", "socks5", "socks5h", "SOCKS5"]) {
			assert.equal(isSocksProxyScheme(s), true, `${s} should be SOCKS`);
		}
	});
	it("rejects http(s) + empty schemes", () => {
		assert.equal(isSocksProxyScheme("http"), false);
		assert.equal(isSocksProxyScheme("https"), false);
		assert.equal(isSocksProxyScheme(undefined), false);
		assert.equal(isSocksProxyScheme(""), false);
	});
});

describe("buildSocksDispatcher", () => {
	it("constructs a working undici dispatcher for socks5:// (no throw)", async () => {
		const d = (await buildSocksDispatcher("socks5://127.0.0.1:1080")) as { close?: () => Promise<void> };
		assert.ok(d, "dispatcher must be returned");
		assert.equal(typeof d.close, "function", "an undici Agent exposes close()");
		await d.close?.();
	});

	it("constructs for socks5h:// with userinfo creds", async () => {
		const d = (await buildSocksDispatcher("socks5h://user:pass@127.0.0.1:9050")) as {
			close?: () => Promise<void>;
		};
		assert.ok(d);
		await d.close?.();
	});

	it("constructs for socks4://", async () => {
		const d = (await buildSocksDispatcher("socks4://127.0.0.1:1080")) as { close?: () => Promise<void> };
		assert.ok(d);
		await d.close?.();
	});

	it("throws on a malformed proxy URL", async () => {
		await assert.rejects(() => buildSocksDispatcher("not-a-url"));
	});
});
