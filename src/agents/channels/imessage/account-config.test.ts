/**
 * iMessage account-config resolvers — the new parity knobs (Fixes 2, 3, 4, 10).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	coerceIMessageChunkMode,
	normalizeIMessageSelfHandle,
	resolveIMessageAccount,
	resolveIMessageChunkMode,
	resolveIMessageDefaultTo,
	resolveIMessageDmHistoryLimit,
	resolveIMessageHistoryLimit,
	resolveIMessageIncludeAttachments,
	resolveIMessageRemoteHost,
	resolveIMessageSelfHandle,
	resolveIMessageTextChunkLimit,
	DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT,
} from "./account-config.js";
import type { BrigadeConfig } from "../sdk.js";

const cfg = (imessage: Record<string, unknown>): BrigadeConfig =>
	({ channels: { imessage: { enabled: true, ...imessage } } }) as unknown as BrigadeConfig;

describe("normalizeIMessageSelfHandle", () => {
	it("lower-cases an email and keeps a phone's digits", () => {
		assert.equal(normalizeIMessageSelfHandle("Bot@Example.COM"), "bot@example.com");
		assert.equal(normalizeIMessageSelfHandle("+1 (555) 123-4567"), "15551234567");
		assert.equal(normalizeIMessageSelfHandle(""), "");
		assert.equal(normalizeIMessageSelfHandle(undefined), "");
	});
});

describe("selfHandle resolution", () => {
	it("reads top-level, normalised", () => {
		assert.equal(resolveIMessageSelfHandle(cfg({ selfHandle: "+1 555 123 4567" })), "15551234567");
	});
	it("per-account wins over top-level", () => {
		const c = cfg({ selfHandle: "top@x.com", accounts: [{ id: "work", selfHandle: "work@x.com" }] });
		assert.equal(resolveIMessageSelfHandle(c, "work"), "work@x.com");
	});
	it("is empty when unset", () => {
		assert.equal(resolveIMessageSelfHandle(cfg({})), "");
	});
});

describe("remoteHost resolution", () => {
	it("reads the configured value verbatim (validation happens in the SCP layer)", () => {
		assert.equal(resolveIMessageRemoteHost(cfg({ remoteHost: "brigade@mac" })), "brigade@mac");
		assert.equal(resolveIMessageRemoteHost(cfg({})), "");
	});
});

describe("includeAttachments resolution", () => {
	it("defaults to true, honours an explicit false (per-account wins)", () => {
		assert.equal(resolveIMessageIncludeAttachments(cfg({})), true);
		assert.equal(resolveIMessageIncludeAttachments(cfg({ includeAttachments: false })), false);
		const c = cfg({ includeAttachments: true, accounts: [{ id: "quiet", includeAttachments: false }] });
		assert.equal(resolveIMessageIncludeAttachments(c, "quiet"), false);
	});
});

describe("defaultTo resolution", () => {
	it("reads the configured default recipient", () => {
		assert.equal(resolveIMessageDefaultTo(cfg({ defaultTo: "+15550001111" })), "+15550001111");
		assert.equal(resolveIMessageDefaultTo(cfg({})), "");
	});
});

describe("history limits", () => {
	it("default 0 (off); coerces a positive integer", () => {
		assert.equal(resolveIMessageHistoryLimit(cfg({})), 0);
		assert.equal(resolveIMessageHistoryLimit(cfg({ historyLimit: 8 })), 8);
		assert.equal(resolveIMessageDmHistoryLimit(cfg({ dmHistoryLimit: 3 })), 3);
		assert.equal(resolveIMessageHistoryLimit(cfg({ historyLimit: -5 })), 0);
	});
});

describe("textChunkLimit + chunkMode", () => {
	it("textChunkLimit defaults to the iMessage default and honours an override", () => {
		assert.equal(resolveIMessageTextChunkLimit(cfg({})), DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT);
		assert.equal(resolveIMessageTextChunkLimit(cfg({ textChunkLimit: 1200 })), 1200);
		assert.equal(resolveIMessageTextChunkLimit(cfg({ textChunkLimit: 0 })), DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT);
	});
	it("chunkMode coerces to the typed union (default length)", () => {
		assert.equal(coerceIMessageChunkMode("newline"), "newline");
		assert.equal(coerceIMessageChunkMode("LENGTH"), "length");
		assert.equal(coerceIMessageChunkMode("garbage"), "length");
		assert.equal(coerceIMessageChunkMode(undefined), "length");
		assert.equal(resolveIMessageChunkMode(cfg({ chunkMode: "newline" })), "newline");
	});
});

describe("resolveIMessageAccount — folds the new knobs into the resolved view", () => {
	it("carries selfHandle / includeAttachments / textChunkLimit / chunkMode / history", () => {
		const acct = resolveIMessageAccount(
			cfg({
				selfHandle: "+1 555 999 0000",
				includeAttachments: false,
				textChunkLimit: 2000,
				chunkMode: "newline",
				historyLimit: 6,
				dmHistoryLimit: 2,
				defaultTo: "+15551112222",
				remoteHost: "brigade@mac",
			}),
		);
		assert.equal(acct.selfHandle, "15559990000");
		assert.equal(acct.includeAttachments, false);
		assert.equal(acct.textChunkLimit, 2000);
		assert.equal(acct.chunkMode, "newline");
		assert.equal(acct.historyLimit, 6);
		assert.equal(acct.dmHistoryLimit, 2);
		assert.equal(acct.defaultTo, "+15551112222");
		assert.equal(acct.remoteHost, "brigade@mac");
	});

	it("sane defaults when nothing is configured", () => {
		const acct = resolveIMessageAccount(cfg({}));
		assert.equal(acct.selfHandle, "");
		assert.equal(acct.includeAttachments, true);
		assert.equal(acct.textChunkLimit, DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT);
		assert.equal(acct.chunkMode, "length");
		assert.equal(acct.historyLimit, 0);
		assert.equal(acct.remoteHost, "");
	});
});
