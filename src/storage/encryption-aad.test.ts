import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetEncryptionKeyCacheForTests, open, openToString, sealString } from "./encryption.js";

/**
 * AAD-binding property test — the at-rest guarantee Tideline 0.5 relies on.
 *
 * Memory content is sealed with a per-row AAD (`memoryFacts|ws|memoryId|origin`,
 * see ConvexMemoryStore.factAad). These tests pin the underlying crypto:
 *   - the same AAD round-trips,
 *   - ANY change to the bound context (row / workspace / origin) fails to
 *     decrypt — so a sealed blob can't be shuffled to another row at the
 *     convex layer and still be read,
 *   - an AAD-bound blob can't be opened with NO AAD (the binding is enforced),
 *   - legacy content sealed WITHOUT an AAD still opens with no AAD (the
 *     fallback path that keeps pre-hardening rows readable).
 */

const TEST_KEY = "a".repeat(64); // 32 bytes, valid hex
let prevKey: string | undefined;

beforeEach(() => {
	prevKey = process.env.BRIGADE_ENCRYPTION_KEY;
	process.env.BRIGADE_ENCRYPTION_KEY = TEST_KEY;
	__resetEncryptionKeyCacheForTests();
});
afterEach(() => {
	if (prevKey === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY;
	else process.env.BRIGADE_ENCRYPTION_KEY = prevKey;
	__resetEncryptionKeyCacheForTests();
});

describe("AAD binding — Tideline 0.5 at-rest seal context", () => {
	const aad = "memoryFacts|ws1|mem_abc|owner";

	it("content sealed with an AAD round-trips with the SAME AAD", () => {
		const sealed = sealString("the deploy key rotates weekly", aad);
		assert.equal(openToString(sealed, aad), "the deploy key rotates weekly");
	});

	it("a blob can't be moved to a different ROW (memoryId) and still decrypt", () => {
		const sealed = sealString("secret", aad);
		assert.throws(() => openToString(sealed, "memoryFacts|ws1|mem_OTHER|owner"), /failed to decrypt/);
	});

	it("a blob can't be moved to a different WORKSPACE and still decrypt", () => {
		const sealed = sealString("secret", aad);
		assert.throws(() => openToString(sealed, "memoryFacts|ws2|mem_abc|owner"), /failed to decrypt/);
	});

	it("a blob can't have its ORIGIN relabelled (owner→channel) and still decrypt", () => {
		const sealed = sealString("secret", aad);
		assert.throws(() => openToString(sealed, "memoryFacts|ws1|mem_abc|channel"), /failed to decrypt/);
	});

	it("an AAD-bound blob fails to open with NO AAD (binding is enforced, not optional)", () => {
		const sealed = sealString("secret", aad);
		assert.throws(() => openToString(sealed), /failed to decrypt/);
	});

	it("legacy content sealed WITHOUT an AAD still opens with no AAD (back-compat fallback)", () => {
		const sealed = sealString("legacy fact, pre-hardening");
		assert.equal(openToString(sealed), "legacy fact, pre-hardening");
	});

	it("raw plaintext starting with the magic byte passes through, NOT parsed as a sealed payload", () => {
		// Even with a key configured, open() gates on a full minimum envelope
		// AND magic AND version. This case exercises the SHORT-payload length
		// gate: "Brigade" is 7 bytes — below the 30-byte envelope floor
		// (HEADER_LEN + NONCE_LEN + TAG_LEN) — so it never reaches the magic /
		// version checks and passes through unchanged, even though byte[0] is
		// 0x42 ('B', the magic byte).
		const word = openToString(Buffer.from("Brigade"));
		assert.equal(word, "Brigade");

		// This case exercises the VERSION gate, distinct from the length gate
		// above: byte[0] = 0x42 (magic), byte[1] != VERSION, and ≥ the 30-byte
		// envelope floor — long enough to clear the size check, so it's the
		// wrong version byte (not the length) that makes it pass through.
		const raw = Buffer.alloc(40, 0x00);
		raw[0] = 0x42;
		raw[1] = 0xff;
		assert.deepEqual(open(raw), raw, "30+ byte buffer starting with 0x42 passes through unchanged");
	});
});
