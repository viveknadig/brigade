import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { cleanLocalSourceAfterConvexMigrate } from "./migrate.js";
import { readSentinel } from "./sentinel.js";

/**
 * The post-migrate hygiene primitive for `filesystem → convex`. Pinned in
 * isolation because it's the one destructive step in the migrate path and its
 * ORDER is load-bearing: wipe the whole local source (so no stale state — most
 * importantly the PLAINTEXT filesystem auth — survives the flip), THEN re-pin
 * the convex sentinel (the wipe removed it, and a missing sentinel makes the
 * next boot silently fall back to filesystem and read an empty store).
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-migclean-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("cleanLocalSourceAfterConvexMigrate", () => {
	it("wipes the stale local source (incl. plaintext auth) but leaves a convex sentinel re-pinned", () => {
		// Seed a filesystem-phase local state, including the sensitive bits.
		fs.mkdirSync(path.join(dir, "agents", "main", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "agents", "main", "agent", "auth-profiles.json"),
			'{"profiles":[{"apiKey":"sk-PLAINTEXT-SECRET"}]}',
		);
		fs.mkdirSync(path.join(dir, "workspace", "memory"), { recursive: true });
		fs.writeFileSync(path.join(dir, "workspace", "memory", "facts.jsonl"), '{"memoryId":"x"}\n');
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(dir, "mode.sentinel"), '{"mode":"filesystem"}');

		cleanLocalSourceAfterConvexMigrate(dir, "http://127.0.0.1:3210");

		// Every stale filesystem-phase artifact is gone — no leftovers, no
		// plaintext key lingering on disk after the switch to convex.
		assert.equal(
			fs.existsSync(path.join(dir, "agents")),
			false,
			"the plaintext auth tree is removed",
		);
		assert.equal(
			fs.existsSync(path.join(dir, "workspace", "memory", "facts.jsonl")),
			false,
			"the filesystem memory log is removed",
		);
		assert.equal(fs.existsSync(path.join(dir, "sessions")), false, "stale sessions are removed");

		// …but the sentinel SURVIVED the wipe and now points at convex + the URL,
		// so the next boot reads from convex, not an empty filesystem store.
		const sentinel = readSentinel({ stateDir: dir });
		assert.equal(sentinel?.mode, "convex", "re-pinned to convex");
		assert.equal(sentinel?.convexUrl, "http://127.0.0.1:3210", "the URL is carried onto the sentinel");
	});

	it("re-pins even when the source had no sentinel to begin with", () => {
		// A source dir with data but somehow no sentinel must still end convex-pinned.
		fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
		fs.writeFileSync(path.join(dir, "workspace", "AGENTS.md"), "persona");

		cleanLocalSourceAfterConvexMigrate(dir, "https://team.convex.cloud");

		const sentinel = readSentinel({ stateDir: dir });
		assert.equal(sentinel?.mode, "convex");
		assert.equal(sentinel?.convexUrl, "https://team.convex.cloud");
		assert.equal(fs.existsSync(path.join(dir, "workspace", "AGENTS.md")), false, "workspace wiped");
	});
});
