import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetEncryptionKeyCacheForTests, deriveSubkey, open, seal } from "./encryption.js";

/**
 * HKDF per-origin subkeys (Tideline step 18) — the crypto-isolation layer that
 * makes multi-tenancy a plug-in. Content seals with a subkey DERIVED from the
 * origin (+ the master), so: a cross-origin read needs the right context, and a
 * cross-TENANT read (different master/root) can't derive the subkey at all.
 */

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

let saved: string | undefined;
let savedOld: string | undefined;
let savedFile: string | undefined;
function useKey(hex: string | undefined): void {
	if (hex === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY;
	else process.env.BRIGADE_ENCRYPTION_KEY = hex;
	__resetEncryptionKeyCacheForTests();
}

beforeEach(() => {
	saved = process.env.BRIGADE_ENCRYPTION_KEY;
	savedOld = process.env.BRIGADE_ENCRYPTION_KEY_OLD;
	savedFile = process.env.BRIGADE_ENCRYPTION_KEY_FILE;
	// Drop any rotated-out OLD key from the ambient env: a stray OLD key would
	// give open() an extra candidate, so the cross-origin / cross-tenant "can't
	// decrypt" assertions could silently pass for the wrong reason. Managed like
	// the primary key (snapshot here, restore in afterEach).
	delete process.env.BRIGADE_ENCRYPTION_KEY_OLD;
	// Neutralize the key-FILE fallback: getKeys() falls back to the real OS key
	// file when no env key is set, so on a machine that has one, the "no key →
	// passthrough" test would silently exercise the ENCRYPT path. Point it at a
	// guaranteed-nonexistent path.
	process.env.BRIGADE_ENCRYPTION_KEY_FILE = path.join(os.tmpdir(), "brigade-hkdf-test-no-such-key.key");
	__resetEncryptionKeyCacheForTests();
});
afterEach(() => {
	if (savedOld === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY_OLD;
	else process.env.BRIGADE_ENCRYPTION_KEY_OLD = savedOld;
	if (savedFile === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY_FILE;
	else process.env.BRIGADE_ENCRYPTION_KEY_FILE = savedFile;
	useKey(saved);
});

describe("HKDF per-origin subkeys — multi-tenant-ready isolation", () => {
	it("deriveSubkey is deterministic; distinct per context AND per master", () => {
		const m = Buffer.from(KEY_A, "hex");
		const m2 = Buffer.from(KEY_B, "hex");
		assert.deepEqual(deriveSubkey(m, "owner"), deriveSubkey(m, "owner"), "same master+context → same subkey");
		assert.notDeepEqual(deriveSubkey(m, "owner"), deriveSubkey(m, "channel|wa"), "context separates subkeys");
		assert.notDeepEqual(deriveSubkey(m, "owner"), deriveSubkey(m2, "owner"), "master/root separates subkeys");
	});

	it("same origin context round-trips", () => {
		useKey(KEY_A);
		const sealed = seal("the user lives in Hyderabad", "aad1", "mem|ws|owner");
		assert.equal(open(sealed, "aad1", "mem|ws|owner").toString("utf8"), "the user lives in Hyderabad");
	});

	it("CROSS-ORIGIN: a fact sealed for origin A can't be opened with origin B's context", () => {
		useKey(KEY_A);
		const sealed = seal("owner secret", "aad", "mem|ws|owner");
		assert.throws(() => open(sealed, "aad", "mem|ws|channel|wa|c1|s1"), /failed to decrypt/);
	});

	it("MULTI-TENANT: sealed under tenant A's root, can't be opened with tenant B's root (same context)", () => {
		useKey(KEY_A);
		const sealed = seal("tenant A data", "aad", "mem|ws|owner");
		useKey(KEY_B); // a different tenant's master/root
		assert.throws(() => open(sealed, "aad", "mem|ws|owner"), /failed to decrypt/);
	});

	it("LEGACY: a fact sealed with the raw master (pre-HKDF) still opens WITH a context (organic migration)", () => {
		useKey(KEY_A);
		const legacy = seal("old fact", "aad"); // no keyContext → sealed with the master directly
		assert.equal(open(legacy, "aad", "mem|ws|owner").toString("utf8"), "old fact", "context-open falls back to the master");
	});

	it("no key configured → passthrough (context ignored, NOT encrypted)", () => {
		useKey(undefined);
		const out = seal("plain", undefined, "mem|ws|owner");
		assert.equal(open(out, undefined, "mem|ws|owner").toString("utf8"), "plain");
		// Passthrough means the raw plaintext bytes — prove it carries no sealed
		// envelope (else the key-file fallback leaked a real key into this test).
		assert.deepEqual(new Uint8Array(out), new Uint8Array(Buffer.from("plain", "utf8")), "output is raw plaintext, not sealed");
	});
});
