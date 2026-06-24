import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	__resetDiscordDirectoryCacheForTest,
	DISCORD_DIRECTORY_CACHE_MAX,
	rememberDiscordUser,
	resolveDiscordHandle,
} from "./directory-cache.js";

afterEach(() => __resetDiscordDirectoryCacheForTest());

describe("discord directory-cache (Fix 2a)", () => {
	it("remembers a username and resolves it (case-insensitive, @-tolerant)", () => {
		rememberDiscordUser("default", { id: "111", username: "alex" });
		assert.equal(resolveDiscordHandle("default", "alex"), "111");
		assert.equal(resolveDiscordHandle("default", "ALEX"), "111");
		assert.equal(resolveDiscordHandle("default", "@alex"), "111");
	});

	it("remembers the display name too (single-word only)", () => {
		rememberDiscordUser("default", { id: "222", username: "bob_id", displayName: "Bob The Builder" });
		rememberDiscordUser("default", { id: "333", username: "carol", displayName: "Caz" });
		assert.equal(resolveDiscordHandle("default", "carol"), "333");
		assert.equal(resolveDiscordHandle("default", "caz"), "333");
		assert.equal(resolveDiscordHandle("default", "bob_id"), "222");
		// A multi-word display name can't be a handle key.
		assert.equal(resolveDiscordHandle("default", "Bob The Builder"), undefined);
	});

	it("remembers a username#discriminator both with and without the discriminator", () => {
		rememberDiscordUser("default", { id: "444", username: "dave#1234" });
		assert.equal(resolveDiscordHandle("default", "dave#1234"), "444");
		assert.equal(resolveDiscordHandle("default", "dave"), "444");
	});

	it("returns undefined for an unknown handle", () => {
		rememberDiscordUser("default", { id: "111", username: "alex" });
		assert.equal(resolveDiscordHandle("default", "nobody"), undefined);
	});

	it("is account-scoped — a handle on account A is not visible on account B", () => {
		rememberDiscordUser("acctA", { id: "111", username: "alex" });
		assert.equal(resolveDiscordHandle("acctA", "alex"), "111");
		assert.equal(resolveDiscordHandle("acctB", "alex"), undefined);
	});

	it("rejects a non-snowflake id (never remembers garbage)", () => {
		rememberDiscordUser("default", { id: "not-a-snowflake", username: "ghost" });
		assert.equal(resolveDiscordHandle("default", "ghost"), undefined);
	});

	it("rejects a multi-word handle key", () => {
		rememberDiscordUser("default", { id: "999", username: "two words" });
		assert.equal(resolveDiscordHandle("default", "two words"), undefined);
	});

	it("a later id for the same handle wins (re-remember)", () => {
		rememberDiscordUser("default", { id: "111", username: "alex" });
		rememberDiscordUser("default", { id: "222", username: "alex" });
		assert.equal(resolveDiscordHandle("default", "alex"), "222");
	});

	it("evicts the oldest entry past the cap (LRU)", () => {
		for (let i = 0; i < DISCORD_DIRECTORY_CACHE_MAX + 5; i++) {
			rememberDiscordUser("default", { id: String(1000 + i), username: `user${i}` });
		}
		// The earliest handle should have been evicted.
		assert.equal(resolveDiscordHandle("default", "user0"), undefined);
		// A recent one survives.
		const lastIdx = DISCORD_DIRECTORY_CACHE_MAX + 4;
		assert.equal(resolveDiscordHandle("default", `user${lastIdx}`), String(1000 + lastIdx));
	});

	it("a normalized account id falls back to 'default' (empty/undefined collapse)", () => {
		rememberDiscordUser(undefined, { id: "111", username: "alex" });
		assert.equal(resolveDiscordHandle("", "alex"), "111");
		assert.equal(resolveDiscordHandle("default", "alex"), "111");
	});
});
