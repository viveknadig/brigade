import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { MemoryCapability } from "../extensions/types.js";
import { buildAutoRecallBlock } from "./auto-recall.js";
import { createDefaultMemoryCapability } from "./plugin-runtime.js";
import { FactStore, type MemoryRecordOrigin } from "./records.js";

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
		// Prove a real recall hit occurred FIRST — otherwise accessCount===0 is a
		// tautology (no surfaced fact would also be 0). Then assert the hit did
		// NOT reinforce.
		const block = buildAutoRecallBlock(dir, "windows platform") as string | undefined;
		assert.match(block ?? "", /Windows/, "fact surfaced");
		// Auto-recall is a passive pre-turn injection — it must not inflate
		// accessCount (that's reserved for the explicit recall_memory tool, so
		// decay reinforcement isn't double-counted).
		assert.equal(new FactStore(dir).list()[0]?.accessCount, 0);
	});

	it("empty store → undefined", () => {
		assert.equal(buildAutoRecallBlock(dir, "anything"), undefined);
	});
});

describe("buildAutoRecallBlock — capability path (the production overload)", () => {
	it("default capability ORIGIN-FILTERS: a channel peer never sees owner facts (and vice-versa)", async () => {
		const store = new FactStore(dir);
		const owner: MemoryRecordOrigin = { kind: "owner" };
		const peer: MemoryRecordOrigin = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" };
		store.write({ content: "the owner deploys on Fridays", segment: "project", createdBy: owner });
		store.write({ content: "the peer prefers spaces over tabs", segment: "preference", createdBy: peer });
		const cap = createDefaultMemoryCapability({ workspaceDir: dir });

		const ownerBlock = await buildAutoRecallBlock(cap, "deploys Fridays spaces tabs", { origin: owner });
		assert.match(ownerBlock ?? "", /Fridays/, "owner sees the owner fact");
		assert.doesNotMatch(ownerBlock ?? "", /the peer prefers/, "owner does NOT see the peer fact");

		const peerBlock = await buildAutoRecallBlock(cap, "deploys Fridays spaces tabs", { origin: peer });
		assert.match(peerBlock ?? "", /spaces over tabs/, "peer sees its own fact");
		assert.doesNotMatch(peerBlock ?? "", /Fridays/, "peer does NOT see the owner fact (isolation)");
	});

	it("default capability is PASSIVE: auto-recall does NOT reinforce accessCount (markAccessed:false)", async () => {
		// Auto-recall is a pre-turn injection — it must not count as a "hit" (only the
		// explicit recall_memory tool reinforces decay). The capability branch passes
		// markAccessed:false on its own; the legacy string-overload test covers the
		// other branch, this pins the PRODUCTION (capability) path.
		const owner: MemoryRecordOrigin = { kind: "owner" };
		const store = new FactStore(dir);
		store.write({ content: "User is on Windows.", segment: "identity", createdBy: owner });
		const cap = createDefaultMemoryCapability({ workspaceDir: dir });
		const block = await buildAutoRecallBlock(cap, "windows platform", { origin: owner });
		assert.match(block ?? "", /Windows/, "the fact was surfaced");
		// The capability path renders the SAME untrusted fence + anti-hallucination
		// prelude as the legacy string path (regression: only the string path was checked).
		assert.match(block ?? "", /<untrusted-memory>/, "capability path wraps facts in the untrusted fence");
		assert.match(block ?? "", /LIVE TOOL wins/, "capability path carries the anti-hallucination prelude");
		assert.equal(new FactStore(dir).list({ origin: owner })[0]?.accessCount, 0, "auto-recall did not reinforce decay");
	});

	it("plugin capability THREADS a channel origin's sessionKey (isolation contract), omits it for owner", async () => {
		const captured: Array<{ limit?: number; sessionKey?: string } | undefined> = [];
		const plugin: MemoryCapability = {
			id: "stub.plugin",
			label: "Stub",
			async search(_q, opts) {
				captured.push(opts);
				return [{ id: "1", content: "plugin hit", score: 1, source: "memory" }];
			},
			async recordFact() {
				return { id: "1" };
			},
		};
		const channelBlock = await buildAutoRecallBlock(plugin, "q", {
			origin: { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "sess-xyz" },
		});
		assert.equal(captured.at(-1)?.sessionKey, "sess-xyz", "a channel origin threads its sessionKey to the plugin");
		// The plugin hit is rendered as `[source] content` inside the untrusted fence.
		assert.match(channelBlock ?? "", /\[memory\] plugin hit/, "plugin hit renders source + content");
		assert.match(channelBlock ?? "", /<untrusted-memory>/, "plugin path wraps the hit in the untrusted fence");
		await buildAutoRecallBlock(plugin, "q", { origin: { kind: "owner" } });
		assert.equal(captured.at(-1)?.sessionKey, undefined, "an owner origin omits sessionKey");
	});
});
