/**
 * Tests for shared web-provider helpers — key resolution, header
 * sanitization, freshness/date parsing, hit wrapping.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	makeProviderCacheKey,
	normalizeFreshnessPreset,
	parseIsoDate,
	readProviderConfigSlot,
	resolveProviderApiKey,
	resolveSiteName,
	sanitizeHeaderToken,
	wrapSearchHit,
} from "./web-provider-helpers.js";

describe("sanitizeHeaderToken", () => {
	it("strips CR/LF/NUL/tab", () => {
		assert.equal(sanitizeHeaderToken("abc\r\n\0\tdef"), "abcdef");
	});
	it("strips non-ASCII bytes", () => {
		assert.equal(sanitizeHeaderToken("hï"), "h");
	});
	it("preserves printable ASCII", () => {
		assert.equal(sanitizeHeaderToken("brave-key_123-ABC"), "brave-key_123-ABC");
	});
});

describe("resolveProviderApiKey", () => {
	it("returns env value when config absent", () => {
		const r = resolveProviderApiKey({
			cfg: {} as never,
			env: { FOO: "from-env" } as never,
			providerId: "brave",
			kind: "search",
			envVars: ["FOO"],
		});
		assert.equal(r, "from-env");
	});

	it("prefers config over env", () => {
		const r = resolveProviderApiKey({
			cfg: {
				tools: {
					web: {
						search: { providers: { brave: { apiKey: "from-cfg" } } },
					},
				},
			} as never,
			env: { FOO: "from-env" } as never,
			providerId: "brave",
			kind: "search",
			envVars: ["FOO"],
		});
		assert.equal(r, "from-cfg");
	});

	it("returns undefined when none present", () => {
		const r = resolveProviderApiKey({
			cfg: {} as never,
			env: {} as never,
			providerId: "brave",
			kind: "search",
			envVars: ["FOO"],
		});
		assert.equal(r, undefined);
	});

	it("strips CR/LF from env value (header-injection defense)", () => {
		const r = resolveProviderApiKey({
			cfg: {} as never,
			env: { FOO: "key\r\nSmuggled: evil" } as never,
			providerId: "x",
			kind: "search",
			envVars: ["FOO"],
		});
		assert.equal(r, "keySmuggled: evil");
		assert.ok(!r?.includes("\r"));
	});

	it("returns undefined when sanitization yields empty", () => {
		const r = resolveProviderApiKey({
			cfg: {} as never,
			env: { FOO: "\r\n" } as never,
			providerId: "x",
			kind: "search",
			envVars: ["FOO"],
		});
		assert.equal(r, undefined);
	});
});

describe("readProviderConfigSlot", () => {
	it("returns empty when slot absent", () => {
		assert.deepEqual(
			readProviderConfigSlot({ cfg: {} as never, providerId: "x", kind: "search" }),
			{},
		);
	});

	it("returns the configured slot", () => {
		const cfg = {
			tools: {
				web: {
					search: { providers: { brave: { country: "us", freshness: "week" } } },
				},
			},
		};
		const slot = readProviderConfigSlot<{ country?: string; freshness?: string }>({
			cfg: cfg as never,
			providerId: "brave",
			kind: "search",
		});
		assert.equal(slot.country, "us");
		assert.equal(slot.freshness, "week");
	});
});

describe("resolveSiteName", () => {
	it("returns hostname for valid URLs", () => {
		assert.equal(resolveSiteName("https://www.example.com/path"), "www.example.com");
	});

	it("returns undefined for invalid URLs", () => {
		assert.equal(resolveSiteName("not a url"), undefined);
	});
});

describe("normalizeFreshnessPreset", () => {
	it("accepts short forms", () => {
		assert.equal(normalizeFreshnessPreset("d"), "d");
		assert.equal(normalizeFreshnessPreset("w"), "w");
	});

	it("accepts long forms", () => {
		assert.equal(normalizeFreshnessPreset("day"), "day");
		assert.equal(normalizeFreshnessPreset("month"), "month");
	});

	it("returns undefined for garbage", () => {
		assert.equal(normalizeFreshnessPreset("hour"), undefined);
		assert.equal(normalizeFreshnessPreset(undefined), undefined);
	});
});

describe("parseIsoDate", () => {
	it("accepts YYYY-MM-DD", () => {
		assert.equal(parseIsoDate("2026-05-24"), "2026-05-24");
	});
	it("rejects wrong format", () => {
		assert.equal(parseIsoDate("24-05-2026"), undefined);
		assert.equal(parseIsoDate("2026/05/24"), undefined);
	});
});

describe("wrapSearchHit", () => {
	it("wraps title + snippet + siteName in envelope, leaves URL raw", () => {
		const h = wrapSearchHit({
			title: "Hello",
			url: "https://example.com",
			snippet: "world",
			siteName: "example.com",
		});
		assert.match(h.title, /EXTERNAL_UNTRUSTED_CONTENT/);
		assert.match(h.snippet ?? "", /EXTERNAL_UNTRUSTED_CONTENT/);
		assert.match(h.siteName ?? "", /EXTERNAL_UNTRUSTED_CONTENT/);
		assert.equal(h.url, "https://example.com");
	});

	it("undefined snippet stays undefined (no empty envelope)", () => {
		const h = wrapSearchHit({ title: "x", url: "https://example.com" });
		assert.equal(h.snippet, undefined);
	});
});

describe("makeProviderCacheKey", () => {
	it("yields a stable string", () => {
		const k = makeProviderCacheKey(["brave", "q", 10, "us"]);
		assert.equal(typeof k, "string");
		assert.equal(k, k.toLowerCase());
	});
});
