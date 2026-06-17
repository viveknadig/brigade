import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __resetRuntimeContextForTests, createRuntimeContext, setRuntimeContext } from "./runtime-context.js";

/**
 * The storage-mode TOGGLE — the mechanism that routes every subsystem to the
 * filesystem OR convex backend. The mis-route guard (a sentinel-vs-env mismatch
 * must FAIL the boot, never silently pick a backend) is the one thing standing
 * between an operator and writing state to the wrong store, so it's pinned here.
 * Resolution priority: override → `mode.sentinel` → env → default(filesystem).
 */

let dir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	__resetRuntimeContextForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mode-"));
	savedEnv = {
		BRIGADE_MODE: process.env.BRIGADE_MODE,
		BRIGADE_CONVEX_URL: process.env.BRIGADE_CONVEX_URL,
		BRIGADE_FORCE_MODE: process.env.BRIGADE_FORCE_MODE,
	};
	delete process.env.BRIGADE_MODE;
	delete process.env.BRIGADE_CONVEX_URL;
	delete process.env.BRIGADE_FORCE_MODE;
});
afterEach(() => {
	__resetRuntimeContextForTests();
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeSentinel(body: unknown): void {
	fs.writeFileSync(path.join(dir, "mode.sentinel"), JSON.stringify(body));
}

describe("storage-mode resolution (the toggle)", () => {
	it("defaults to filesystem with no sentinel and no env", async () => {
		const ctx = await createRuntimeContext({ stateDir: dir });
		assert.equal(ctx.mode, "filesystem");
	});

	it("honors a filesystem sentinel", async () => {
		writeSentinel({ mode: "filesystem" });
		assert.equal((await createRuntimeContext({ stateDir: dir })).mode, "filesystem");
	});

	it("honors BRIGADE_MODE=filesystem when there is no sentinel", async () => {
		process.env.BRIGADE_MODE = "filesystem";
		assert.equal((await createRuntimeContext({ stateDir: dir })).mode, "filesystem");
	});

	it("THROWS on a sentinel-vs-env mismatch — never silently mis-routes storage", async () => {
		writeSentinel({ mode: "convex", convexUrl: "http://127.0.0.1:3210" });
		process.env.BRIGADE_MODE = "filesystem";
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /differs from/);
	});

	it("BRIGADE_FORCE_MODE=1 SUPPRESSES the mismatch throw and uses the env mode (the escape hatch)", async () => {
		writeSentinel({ mode: "convex", convexUrl: "http://127.0.0.1:3210" });
		process.env.BRIGADE_MODE = "filesystem";
		process.env.BRIGADE_FORCE_MODE = "1";
		assert.equal((await createRuntimeContext({ stateDir: dir })).mode, "filesystem", "force=1 honors the env mode over the sentinel");
	});

	it("BRIGADE_FORCE_MODE must be EXACTLY '1' — a truthy-but-not-'1' value still throws", async () => {
		writeSentinel({ mode: "convex", convexUrl: "http://127.0.0.1:3210" });
		process.env.BRIGADE_MODE = "filesystem";
		process.env.BRIGADE_FORCE_MODE = "true"; // not the sentinel "1"
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /differs from/, "only the exact '1' bypasses");
	});

	it("THROWS on a corrupt sentinel rather than guessing a mode", async () => {
		fs.writeFileSync(path.join(dir, "mode.sentinel"), "{ this is not json");
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /unreadable|fix or delete/);
	});

	it("THROWS on a VALID-JSON sentinel with an out-of-range mode (mode-validity check, distinct from the corrupt-JSON parse)", async () => {
		writeSentinel({ mode: "s3" }); // parses fine; "s3" is not a StorageMode
		// Assert on the mode-validity message specifically — the corrupt-JSON branch
		// never produces "invalid mode in sentinel", so this proves the validity check
		// fired (not a JSON.parse failure), even though both share the outer wrapper.
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /invalid mode in sentinel/);
	});

	it("THROWS on an invalid BRIGADE_MODE value", async () => {
		process.env.BRIGADE_MODE = "bogus";
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /must be/);
	});

	it("trims a padded BRIGADE_MODE=' convex ' before validating", async () => {
		// resolveModeFromEnv calls .trim() on BRIGADE_MODE, so surrounding whitespace
		// must not break the exact "convex" match. Pinned via the mismatch guard: a
		// filesystem sentinel + a trimmed-convex env resolution trips the throw.
		writeSentinel({ mode: "filesystem" });
		process.env.BRIGADE_MODE = " convex ";
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /differs from/);
	});

	it("trims a padded BRIGADE_MODE=' filesystem ' before validating", async () => {
		process.env.BRIGADE_MODE = " filesystem ";
		assert.equal((await createRuntimeContext({ stateDir: dir })).mode, "filesystem");
	});

	it("BRIGADE_CONVEX_URL of only whitespace does NOT resolve to convex (stays filesystem)", async () => {
		// resolveModeFromEnv requires a non-empty trimmed URL, so '   ' is ignored and
		// resolution falls through to the filesystem default.
		process.env.BRIGADE_CONVEX_URL = "   ";
		assert.equal((await createRuntimeContext({ stateDir: dir })).mode, "filesystem");
	});

	it("an explicit override BEATS the sentinel (override wins, no mismatch throw)", async () => {
		writeSentinel({ mode: "convex", convexUrl: "http://127.0.0.1:3210" });
		const ctx = await createRuntimeContext({ stateDir: dir, override: { mode: "filesystem" } });
		assert.equal(ctx.mode, "filesystem", "override is resolved first, ahead of the sentinel");
	});

	it("BRIGADE_CONVEX_URL resolves to convex (env resolution) — proven via the sentinel-vs-env mismatch guard", async () => {
		// `resolveModeFromEnv` is internal (not exported), so the convex-from-URL
		// branch is pinned end-to-end: a filesystem sentinel + a convex-implying
		// URL must trip the mismatch throw, which proves the env resolved to convex
		// without us building a convex store.
		writeSentinel({ mode: "filesystem" });
		process.env.BRIGADE_CONVEX_URL = "http://127.0.0.1:3210";
		await assert.rejects(() => createRuntimeContext({ stateDir: dir }), /differs from/);
	});

	it("convexUrl is DORMANT in filesystem mode — a convex sentinel never hijacks an fs resolution", async () => {
		// runtime-context only reads the sentinel's convexUrl when the resolved mode
		// is convex, so an fs resolution must NOT build a convex store from a present
		// convex sentinel. If it did, this would attempt a convex connection / report
		// mode "convex" instead of cleanly returning filesystem. (The remaining link —
		// the resolved convexUrl reaching the ConvexBrigadeStore client — is exercised
		// by the convex-deploy smoke, not unit-testable without a live backend.)
		writeSentinel({ mode: "convex", convexUrl: "http://127.0.0.1:3210" });
		const ctx = await createRuntimeContext({ stateDir: dir, override: { mode: "filesystem" } });
		assert.equal(ctx.mode, "filesystem", "the convex sentinel's URL stayed dormant under an fs resolution");
	});

	it("an injected store wins (test-injection path) and reports its own mode", async () => {
		// Give the fake a mode the env-less resolution chain can NEVER produce
		// (no sentinel + no env in beforeEach ⇒ default is filesystem), and assert
		// store identity too — so "convex" here can only come from the injection,
		// not a coincidental match with the default.
		const fakeStore = { mode: "convex", init: async () => {} } as never;
		const ctx = await createRuntimeContext({ stateDir: dir, store: fakeStore });
		assert.equal(ctx.mode, "convex");
		assert.equal(ctx.store, fakeStore);
	});
});

describe("runtime context singleton", () => {
	it("rejects a second setRuntimeContext (one context per process)", async () => {
		const ctx = await createRuntimeContext({ stateDir: dir, override: { mode: "filesystem" } });
		setRuntimeContext(ctx);
		assert.throws(() => setRuntimeContext(ctx), /already initialised/);
	});
});
