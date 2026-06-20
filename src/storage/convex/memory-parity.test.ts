import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { MemoryRecord, MemoryRecordOrigin } from "../../agents/memory/records.js";
import { bm25Score } from "../../agents/memory/scoring.js";
import { __resetEncryptionKeyCacheForTests } from "../encryption.js";
import type { MemoryRecord as StoreMemoryRecord } from "../store.js";
import { recordToRowArgs, rowToRecord } from "./memory-store.js";

/**
 * Cross-mode parity gate (Tideline build Step 4, third CI gate). Live recall is
 * the HYBRID scorer (`recallHybrid`: BM25 as the primary lane × trust × decay,
 * with a vector recovery lane) over `FactStore` records; the ONLY thing that
 * differs between fs and convex mode is where those records come from — the fs
 * JSONL vs the convex hydrated cache, which is reconstructed by `rowToRecord`.
 * So fs ≡ convex IFF the flatten→reconstruct round-trip preserves every field
 * recall reads. This gate proves it: round-trip each record through
 * `recordToRowArgs` → `rowToRecord` and assert IDENTICAL ranking AND scores.
 * The lexical-lane assertions below pin the BM25 primary lane (`bm25Score`)
 * directly; the embedding round-trip test pins the vector recovery lane's input.
 * (No encryption key is set, so seal/open pass content through as plaintext.)
 */

const NOW = 1_750_000_000_000;

function rec(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment: "knowledge",
		tier: "long",
		importance: 0.5,
		decayRate: 0.03,
		accessCount: 0,
		lastAccessedAt: NOW,
		createdAt: NOW,
		lifecycle: "active",
		...over,
	};
}

/**
 * The convex marshalling fns are typed against storage/store's looser
 * `MemoryRecord`; our fixtures use the strict agents/memory `MemoryRecord`.
 * They're structurally identical at runtime — bridge the two type-views here.
 * This round-trip is exactly what convex mode does to hydrate the cache.
 */
function roundTrip(ws: string, r: MemoryRecord): MemoryRecord {
	return rowToRecord(recordToRowArgs(ws, r as unknown as StoreMemoryRecord)) as unknown as MemoryRecord;
}

describe("cross-mode parity — fs ranking ≡ convex-marshalled ranking", () => {
	it("the flatten→reconstruct round-trip preserves recall ranking AND scores", () => {
		const records: MemoryRecord[] = [
			rec("home", "I live in Hyderabad India", { importance: 0.85, segment: "identity" }),
			rec("editor", "I prefer tabs over spaces when coding", { importance: 0.7, segment: "preference" }),
			rec("job", "I work at Beta Labs as a staff engineer", { importance: 0.65, segment: "project" }),
			rec("coffee", "I drink black coffee with no sugar", { importance: 0.7, segment: "preference" }),
			rec("pet", "I have a dog named Biscuit", {
				importance: 0.75,
				segment: "relationship",
				accessCount: 4,
				lastAccessedAt: NOW - 3 * 86_400_000, // exercise the decay/recency path
			}),
		];
		const ws = "ws-parity";
		const convexRecords = records.map((r) => roundTrip(ws, r));

		for (const query of [
			"where do I live",
			"tabs spaces coffee preference",
			"work staff engineer at Beta",
			"my dog Biscuit pet name",
		]) {
			const fsRanked = bm25Score(records, query, NOW);
			const cxRanked = bm25Score(convexRecords, query, NOW);
			assert.deepEqual(
				cxRanked.map((s) => s.record.memoryId),
				fsRanked.map((s) => s.record.memoryId),
				`ranking parity for "${query}"`,
			);
			// Lexical-lane (BM25) parity ONLY: `bm25Score` is the lexical scorer
			// (Okapi BM25 × decay/importance). It does NOT apply the
			// sourceType/confidence TRUST multiplier that the production FUSED
			// score folds in — this assertion proves the lexical lane survives the
			// round-trip identically, not the full fused ranking.
			assert.deepEqual(
				cxRanked.map((s) => s.score.toFixed(8)),
				fsRanked.map((s) => s.score.toFixed(8)),
				`lexical-lane score parity for "${query}"`,
			);
		}
	});

	it("the EMBEDDING survives the round-trip (the vector lane reads it; a silent drop would pass the BM25 gates)", () => {
		// Live recall is recallHybrid, which reads record.embedding for the recovery
		// lane. recordToRowArgs marshals it; rowToRecord recovers it via the ...rest
		// spread — untested elsewhere, so a drop there would surface ONLY here.
		const embedding = Array.from({ length: 256 }, (_, i) => (i % 3 === 0 ? 0.0625 : 0));
		const back = roundTrip("ws-emb", rec("emb", "I live in Hyderabad India", { embedding }));
		assert.deepEqual(back.embedding, embedding, "256-dim embedding round-trips through recordToRowArgs ↔ rowToRecord");
	});

	it("the round-trip preserves the origin (createdBy) — isolation survives cache hydration", () => {
		const origin: MemoryRecordOrigin = {
			kind: "channel",
			channelId: "whatsapp",
			conversationId: "c1",
			sessionKey: "s1",
		};
		const back = roundTrip("ws", rec("x", "channel fact", { createdBy: origin }));
		assert.deepEqual(back.createdBy, origin);
	});

	it("a multi-account channel origin round-trips with accountId intact (the multi-account column)", () => {
		const origin: MemoryRecordOrigin = {
			kind: "channel",
			channelId: "whatsapp",
			conversationId: "c1",
			sessionKey: "s1",
			accountId: "acc-1",
		};
		const back = roundTrip("ws", rec("xa", "multi-account channel fact", { createdBy: origin }));
		assert.deepEqual(back.createdBy, origin);
		assert.equal(
			(back.createdBy as Extract<MemoryRecordOrigin, { kind: "channel" }>).accountId,
			"acc-1",
		);
	});

	it("an owner-origin record round-trips with createdBy undefined (legacy/owner default)", () => {
		const back = roundTrip("ws", rec("y", "owner fact")); // no createdBy
		assert.equal(back.createdBy, undefined);
	});

	it("sourceType survives the round-trip — the write-gate reads it in BOTH modes", () => {
		const back = roundTrip("ws", rec("z", "a tool said so", { sourceType: "tool_output" }));
		assert.equal(back.sourceType, "tool_output");
	});

	it("a legacy record (no sourceType) round-trips with sourceType undefined (⇒ trusted)", () => {
		const back = roundTrip("ws", rec("w", "owner-authored fact")); // no sourceType
		assert.equal(back.sourceType, undefined);
	});

	it("cognition fields (bi-temporal / confidence / status / sourcePointers / links / metadata) survive the round-trip — no silent drop", () => {
		const back = roundTrip(
			"ws",
			rec("c1", "a dated, sourced fact", {
				validFrom: 1000,
				validTo: 2000,
				confidence: 0.9,
				status: "provisional",
				sourcePointers: ["msg-1", "doc-2"],
				modality: "audio",
				mediaPointer: "file:///voice/n.ogg",
				subjectKey: "deploy_day",
				links: [{ kind: "relates", target: "z" }],
				metadata: { corrects: "y" },
			}),
		);
		assert.equal(back.validFrom, 1000);
		assert.equal(back.validTo, 2000);
		assert.equal(back.confidence, 0.9);
		assert.equal(back.status, "provisional");
		assert.deepEqual(back.sourcePointers, ["msg-1", "doc-2"]);
		assert.equal(back.modality, "audio", "modality round-trips (step 17)");
		assert.equal(back.mediaPointer, "file:///voice/n.ogg", "mediaPointer round-trips");
		assert.deepEqual(back.links, [{ kind: "relates", target: "z" }], "graph edges (links) round-trip");
		assert.deepEqual(back.metadata, { corrects: "y" }, "metadata sidecar round-trips");
		assert.equal(back.subjectKey, "deploy_day", "attribute slot (subjectKey) round-trips — supersede works in convex mode too");
	});
});

describe("cross-mode parity — ENCRYPTED round-trip (AAD + per-origin HKDF keyContext)", () => {
	// The plaintext gate above can't exercise the seal/open consistency. With a key
	// set, recordToRowArgs seals `content` bound to (workspace, memoryId, originKind)
	// AAD + a per-origin HKDF keyContext; rowToRecord must reconstruct the IDENTICAL
	// aad+keyContext from the flattened columns or decryption fails. This pins that.
	let savedKey: string | undefined;
	let savedFile: string | undefined;
	beforeEach(() => {
		savedKey = process.env.BRIGADE_ENCRYPTION_KEY;
		savedFile = process.env.BRIGADE_ENCRYPTION_KEY_FILE;
		process.env.BRIGADE_ENCRYPTION_KEY = randomBytes(32).toString("hex");
		__resetEncryptionKeyCacheForTests();
	});
	afterEach(() => {
		if (savedKey === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY;
		else process.env.BRIGADE_ENCRYPTION_KEY = savedKey;
		if (savedFile === undefined) delete process.env.BRIGADE_ENCRYPTION_KEY_FILE;
		else process.env.BRIGADE_ENCRYPTION_KEY_FILE = savedFile;
		__resetEncryptionKeyCacheForTests();
	});

	it("an OWNER record's sealed content decrypts back through the round-trip", () => {
		const back = roundTrip("ws-enc", rec("o", "owner secret content", { createdBy: { kind: "owner" } }));
		assert.equal(back.content, "owner secret content");
	});

	it("a CHANNEL record's sealed content decrypts back (per-origin keyContext is reconstructed)", () => {
		const origin: MemoryRecordOrigin = {
			kind: "channel",
			channelId: "whatsapp",
			conversationId: "c1",
			sessionKey: "s1",
			accountId: "acc-1",
		};
		const back = roundTrip("ws-enc", rec("c", "peer secret content", { createdBy: origin }));
		assert.equal(back.content, "peer secret content");
		assert.deepEqual(back.createdBy, origin, "origin survives so the keyContext can be rebuilt");
	});

	it("an owner-default (no createdBy) record round-trips under encryption too", () => {
		const back = roundTrip("ws-enc", rec("d", "legacy owner content")); // createdBy undefined ⇒ "owner" kind on both sides
		assert.equal(back.content, "legacy owner content");
	});
});
