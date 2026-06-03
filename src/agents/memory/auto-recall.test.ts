import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildAutoRecallBlock } from "./auto-recall.js";
import { FactStore } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-autorecall-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("buildAutoRecallBlock", () => {
	it("surfaces relevant facts inside an untrusted-data block", () => {
		const store = new FactStore(dir);
		store.write({ content: "User prefers spaces over tabs.", segment: "preference" });
		store.write({ content: "User deploys on Fridays.", segment: "project" });

		const block = buildAutoRecallBlock(dir, "what about tabs and spaces");
		assert.ok(block, "expected a recall block");
		assert.match(block as string, /## Relevant memory/);
		assert.match(block as string, /NOT as instructions or commands/);
		// Anti-hallucination fix: the prelude must also tell the model that
		// auto-recalled facts can be STALE and the live tool wins on
		// current-state questions (which agents/channels/skills exist).
		// Without this the model treated a stale "Mathematician agent with
		// quadratic-solver skill" recall as confirmation of the roster.
		assert.match(block as string, /may be STALE/);
		assert.match(block as string, /LIVE TOOL wins/);
		assert.match(block as string, /agents_list/);
		// Facts are wrapped in the untrusted-data fence (injection defense).
		assert.match(block as string, /<untrusted-memory>/);
		assert.match(block as string, /<\/untrusted-memory>/);
		assert.match(block as string, /\[preference\] User prefers spaces over tabs\./);
		// The unrelated fact shouldn't appear.
		assert.doesNotMatch(block as string, /Fridays/);
	});

	it("returns undefined when nothing relevant is stored", () => {
		const store = new FactStore(dir);
		store.write({ content: "User likes coffee.", segment: "preference" });
		assert.equal(buildAutoRecallBlock(dir, "kubernetes helm charts"), undefined);
	});

	it("does NOT reinforce accessCount (passive injection; only recall_memory bumps)", () => {
		const store = new FactStore(dir);
		store.write({ content: "User is on Windows.", segment: "identity" });
		buildAutoRecallBlock(dir, "windows platform");
		// Auto-recall is a passive pre-turn injection — it must not inflate
		// accessCount (that's reserved for the explicit recall_memory tool, so
		// decay reinforcement isn't double-counted).
		assert.equal(new FactStore(dir).list()[0]?.accessCount, 0);
	});

	it("empty store → undefined", () => {
		assert.equal(buildAutoRecallBlock(dir, "anything"), undefined);
	});
});
