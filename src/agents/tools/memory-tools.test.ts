import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FileMemoryStore } from "../memory/storage.js";
import { FactStore } from "../memory/records.js";
import { makeReadMemoryTool, makeRecallMemoryTool, makeWriteMemoryTool } from "./memory-tools.js";

let workspace: string;
let store: FileMemoryStore;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-memtools-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
	store = new FileMemoryStore(workspace);
});

afterEach(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function writeMemory(rel: string, content: string): void {
	const full = path.join(workspace, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

describe("write_memory tool + recall integration", () => {
	it("persists a structured fact that recall_memory then finds", async () => {
		const factStore = new FactStore(workspace);
		const write = makeWriteMemoryTool(factStore);
		const w = await write.execute("c1", {
			content: "User prefers spaces over tabs.",
			segment: "preference",
		} as never);
		assert.match((w.content[0] as { text: string }).text, /Remembered \[preference/);

		// recall (markdown store + fact store) surfaces the written fact.
		const recall = makeRecallMemoryTool(store, factStore);
		const r = await recall.execute("c2", { query: "tabs spaces" } as never);
		assert.match((r.content[0] as { text: string }).text, /spaces over tabs/);
		assert.equal(r.details.facts.length, 1);
		assert.equal(r.details.facts[0]?.segment, "preference");
	});

	it("recall marks the fact accessed (decay reinforcement)", async () => {
		const factStore = new FactStore(workspace);
		const write = makeWriteMemoryTool(factStore);
		await write.execute("c1", { content: "Deploys happen on Fridays.", segment: "project" } as never);
		const recall = makeRecallMemoryTool(store, factStore);
		await recall.execute("c2", { query: "deploys Fridays" } as never);
		assert.equal(factStore.list()[0]?.accessCount, 1);
	});
});

describe("recall_memory tool", () => {
	it("has the expected name + shape", () => {
		const tool = makeRecallMemoryTool(store);
		assert.equal(tool.name, "recall_memory");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters);
		assert.match(tool.description, /search/i);
	});

	it("returns matching snippets with file:line citations", async () => {
		writeMemory("MEMORY.md", "User prefers concise replies.");
		writeMemory("memory/2026-05-21.md", "Project uses pytest with -n auto.");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "pytest auto" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /pytest/);
		assert.match(text, /memory\/2026-05-21\.md:/);
		assert.equal(result.details.resultCount >= 1, true);
	});

	it("reports cleanly when nothing matches + nudges toward writing", async () => {
		writeMemory("MEMORY.md", "unrelated");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "kubernetes helm chart" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /No memory matched/i);
		assert.match(text, /memory\/<today>\.md/);
		assert.equal(result.details.resultCount, 0);
	});

	it("throws on missing query (required param)", async () => {
		const tool = makeRecallMemoryTool(store);
		await assert.rejects(() => tool.execute("call-1", {} as never));
	});

	it("respects maxResults", async () => {
		writeMemory("MEMORY.md", "cat\n\ncat\n\ncat\n\ncat\n\ncat");
		const tool = makeRecallMemoryTool(store);
		const result = await tool.execute("call-1", { query: "cat", maxResults: 2 } as never);
		assert.equal(result.details.resultCount, 2);
	});
});

describe("read_memory tool", () => {
	it("has the expected name + shape", () => {
		const tool = makeReadMemoryTool(store);
		assert.equal(tool.name, "read_memory");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters);
	});

	it("reads a memory file and reports the line range", async () => {
		writeMemory("memory/2026-05-21.md", "first\nsecond\nthird");
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "memory/2026-05-21.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /memory\/2026-05-21\.md \(lines 1-3\)/);
		assert.match(text, /first\nsecond\nthird/);
		assert.equal(result.details.status, "ok");
	});

	it("surfaces a path-scope violation as a failed result (not a throw)", async () => {
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "USER.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /not a memory file/i);
		assert.equal(result.details.status, "failed");
	});

	it("surfaces a missing file as a failed result with a recovery hint", async () => {
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "memory/2099-01-01.md" } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /does not exist/i);
		assert.equal(result.details.status, "failed");
	});

	it("windows large reads + reports more-from-line", async () => {
		const big = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n");
		writeMemory("MEMORY.md", big);
		const tool = makeReadMemoryTool(store);
		const result = await tool.execute("call-1", { path: "MEMORY.md", from: 1, lines: 50 } as never);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /more from line 51/);
		assert.equal(result.details.read?.lines, 50);
	});

	it("throws on missing path (required param)", async () => {
		const tool = makeReadMemoryTool(store);
		await assert.rejects(() => tool.execute("call-1", {} as never));
	});
});

describe("write_memory + recall_memory — session-scoped origin tracking", () => {
	const peerA = {
		channelId: "whatsapp",
		conversationId: "14057144199@s.whatsapp.net",
	};
	const peerB = {
		channelId: "whatsapp",
		conversationId: "918888888888@s.whatsapp.net",
	};
	const peerASessionKey = "agent:main:whatsapp:direct:14057144199.deadbeef";
	const peerBSessionKey = "agent:main:whatsapp:direct:918888888888.cafebabe";

	function writeAs(
		scope:
			| { senderIsOwner?: true }
			| { senderIsOwner: false; channelContext: typeof peerA; sessionKey: string },
		content: string,
	): Promise<void> {
		const factStore = new FactStore(workspace);
		const tool = makeWriteMemoryTool(factStore, scope as never);
		return tool
			.execute("c", {
				content,
				segment: "preference",
			} as never)
			.then(() => undefined);
	}

	async function recallAs(
		scope:
			| { senderIsOwner?: true }
			| { senderIsOwner: false; channelContext: typeof peerA; sessionKey: string },
		query: string,
	): Promise<string> {
		const factStore = new FactStore(workspace);
		const tool = makeRecallMemoryTool(store, factStore, scope as never);
		const res = await tool.execute("c", { query } as never);
		return JSON.stringify(res);
	}

	it("a channel PEER never sees operator markdown NOTES (MEMORY.md), even on a matching query", async () => {
		// Notes are operator-authored workspace files with NO per-peer scoping, so
		// the notes lane is OWNER-ONLY — only the facts lane is origin-filtered.
		writeMemory("MEMORY.md", "Operator note: the vault passphrase hint is bluestratosphere.");
		const ownerView = await recallAs({ senderIsOwner: true }, "vault passphrase hint");
		assert.match(ownerView, /bluestratosphere/, "owner sees their own notes");
		const peerView = await recallAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"vault passphrase hint",
		);
		assert.doesNotMatch(peerView, /bluestratosphere/, "a peer must NEVER see operator notes (cross-origin disclosure)");
	});

	it("owner-only: owner writes are stored with createdBy: owner and recallable by owner", async () => {
		await writeAs({ senderIsOwner: true }, "the operator prefers dark mode");
		const factStore = new FactStore(workspace);
		const records = factStore.list();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.createdBy?.kind, "owner");
		// Owner recall sees their own fact.
		const ownerView = await recallAs({ senderIsOwner: true }, "dark mode");
		assert.match(ownerView, /dark mode/);
	});

	it("recall surfaces each fact's memoryId in the rendered text so corrections can supersede it", async () => {
		await writeAs({ senderIsOwner: true }, "the operator deploys on Fridays");
		const id = new FactStore(workspace).list()[0]?.memoryId;
		assert.ok(id, "fact written");
		const view = await recallAs({ senderIsOwner: true }, "deploy");
		// The fact line now carries the id (only in the rendered TEXT — `details` always had it),
		// plus a hint to use it. Without this, the model can't target a fact in write_memory(supersedes).
		assert.ok(view.includes(`id ${id} · preference`), "fact line carries the memoryId for superseding");
		assert.match(view, /To correct one of these/, "recall hints how to supersede");
	});

	it("write_memory with a subjectKey auto-supersedes the prior slot value; recall surfaces the slot", async () => {
		const wtool = makeWriteMemoryTool(new FactStore(workspace), { senderIsOwner: true });
		await wtool.execute("c1", { content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy_day" } as never);
		await wtool.execute("c2", { content: "I deploy on Wednesdays", segment: "correction", subjectKey: "deploy_day" } as never);

		const active = new FactStore(workspace).list({ origin: { kind: "owner" } }).filter((r) => r.subjectKey === "deploy_day");
		assert.equal(active.length, 1, "only the current slot value stays active");
		assert.match(active[0]!.content, /Wednesdays/, "the new value won; the stale one was archived");

		const view = await recallAs({ senderIsOwner: true }, "deploy");
		assert.match(view, /slot deploy_day/, "recall surfaces the attribute slot so the model can reuse it");
		assert.match(view, /Wednesdays/);
	});

	it("peer write is stored with channel origin including sessionKey", async () => {
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"peer A loves Spanish responses",
		);
		const factStore = new FactStore(workspace);
		const records = factStore.list();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.createdBy?.kind, "channel");
		if (records[0]?.createdBy?.kind === "channel") {
			assert.equal(records[0].createdBy.channelId, "whatsapp");
			assert.equal(records[0].createdBy.conversationId, peerA.conversationId);
			assert.equal(records[0].createdBy.sessionKey, peerASessionKey);
		}
	});

	// All "doesNotMatch" assertions below match against the FULL fact
	// content (not just the query token) — the empty-result response
	// echoes the query in its message, so matching on the query alone
	// would create false positives.

	it("operator does NOT see peer-written facts in recall (owner isolation)", async () => {
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"peer A loves Spanish responses",
		);
		const ownerView = await recallAs({ senderIsOwner: true }, "Spanish");
		assert.doesNotMatch(ownerView, /peer A loves Spanish responses/);
	});

	it("peer DOES see their own facts in recall", async () => {
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"peer A loves Spanish responses",
		);
		const peerAView = await recallAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"Spanish",
		);
		assert.match(peerAView, /peer A loves Spanish responses/);
	});

	it("peer B does NOT see peer A's facts (cross-peer isolation)", async () => {
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"peer A loves Spanish responses",
		);
		const peerBView = await recallAs(
			{ senderIsOwner: false, channelContext: peerB, sessionKey: peerBSessionKey },
			"Spanish",
		);
		assert.doesNotMatch(peerBView, /peer A loves Spanish responses/);
	});

	it("peer at session X does NOT see facts they wrote at session Y (cross-session isolation)", async () => {
		// Same peer, two different sessions.
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"a unique session-1 marker note",
		);
		const otherSession = await recallAs(
			{
				senderIsOwner: false,
				channelContext: peerA,
				sessionKey: "agent:main:whatsapp:direct:14057144199.different",
			},
			"marker",
		);
		assert.doesNotMatch(otherSession, /a unique session-1 marker note/);
	});

	it("peer does NOT see operator facts (operator privacy)", async () => {
		await writeAs({ senderIsOwner: true }, "operator credentials are 42");
		const peerView = await recallAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"credentials",
		);
		assert.doesNotMatch(peerView, /operator credentials are 42/);
	});

	it("non-owner without channelContext gets 'no-results' message (no leakage)", async () => {
		await writeAs({ senderIsOwner: true }, "private operator note");
		const tool = makeRecallMemoryTool(store, new FactStore(workspace), {
			senderIsOwner: false,
		});
		const res = await tool.execute("c", { query: "private" } as never);
		const text = JSON.stringify(res);
		assert.doesNotMatch(text, /private operator note/);
		assert.match(text, /no memory matched|peer-scoped memory can't be searched/i);
	});

	it("dedup does NOT merge across origins (peer's fact stays separate from owner's identical fact)", async () => {
		await writeAs({ senderIsOwner: true }, "loves dark mode");
		await writeAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"loves dark mode",
		);
		const factStore = new FactStore(workspace);
		const records = factStore.list();
		// Two records — dedup must not merge across owners.
		assert.equal(records.length, 2);
		const origins = records.map((r) => r.createdBy?.kind).sort();
		assert.deepEqual(origins, ["channel", "owner"]);
	});

	it("legacy (createdBy undefined) records are treated as owner-only", async () => {
		// Write a record directly to the store with no createdBy.
		const factStore = new FactStore(workspace);
		factStore.write({ content: "loves ramen for breakfast", segment: "preference" });
		const records = factStore.list();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.createdBy, undefined);

		// Owner can recall it. Query is "ramen" (not the full content) so the
		// query echo in the response can't accidentally satisfy the match.
		const ownerView = await recallAs({ senderIsOwner: true }, "ramen");
		assert.match(ownerView, /loves ramen for breakfast/);

		// Peer cannot — legacy records resolve to owner origin.
		const peerView = await recallAs(
			{ senderIsOwner: false, channelContext: peerA, sessionKey: peerASessionKey },
			"ramen",
		);
		assert.doesNotMatch(peerView, /loves ramen for breakfast/);
	});
});
