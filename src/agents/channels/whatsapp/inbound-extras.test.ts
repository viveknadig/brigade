/**
 * Unit tests for `extractMentions` / `extractReplyContext` — the LID-aware
 * inbound enrichment helpers. The pure work is the envelope walk + LID
 * resolution chain; we stub the Baileys socket with just the
 * `signalRepository.lidMapping.getPNForLID` member the resolver needs.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { WAMessage } from "@whiskeysockets/baileys";

import { extractMentions, extractReplyContext } from "./inbound-extras.js";

type FakeSock = Parameters<typeof extractMentions>[1];

function makeSock(lidTable: Record<string, string> = {}): FakeSock {
	return {
		signalRepository: {
			lidMapping: {
				getPNForLID: async (lidJid: string) => lidTable[lidJid] ?? null,
			},
		},
	} as unknown as FakeSock;
}

/** Wrap a typical mention payload in an `extendedTextMessage.contextInfo` envelope. */
function withMentions(mentioned: string[], replyTo?: { stanzaId?: string; participant?: string; body?: string }): WAMessage["message"] {
	const contextInfo: Record<string, unknown> = { mentionedJid: mentioned };
	if (replyTo) {
		if (replyTo.stanzaId) contextInfo.stanzaId = replyTo.stanzaId;
		if (replyTo.participant) contextInfo.participant = replyTo.participant;
		if (replyTo.body) contextInfo.quotedMessage = { conversation: replyTo.body };
	}
	return { extendedTextMessage: { text: "msg body", contextInfo } } as unknown as WAMessage["message"];
}

describe("extractMentions", () => {
	it("returns [] when message is null", async () => {
		const sock = makeSock();
		assert.deepEqual(await extractMentions(null as never, sock), []);
		assert.deepEqual(await extractMentions(undefined as never, sock), []);
	});

	it("returns [] when no context-bearing envelope is present", async () => {
		const sock = makeSock();
		const msg = { conversation: "plain text" } as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), []);
	});

	it("returns [] when contextInfo carries no mentions", async () => {
		const sock = makeSock();
		const msg = { extendedTextMessage: { text: "x", contextInfo: {} } } as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), []);
	});

	it("resolves a plain phone-jid mention to its canonical digits", async () => {
		const sock = makeSock();
		const msg = withMentions(["15551234567@s.whatsapp.net"]);
		assert.deepEqual(await extractMentions(msg, sock), ["15551234567"]);
	});

	it("resolves a LID-aliased mention via the signalRepository table", async () => {
		const sock = makeSock({ "999111@lid": "447700900123@s.whatsapp.net" });
		const msg = withMentions(["999111@lid"]);
		assert.deepEqual(await extractMentions(msg, sock), ["447700900123"]);
	});

	it("DROPS unresolvable LID mentions (does not invent a fake id)", async () => {
		const sock = makeSock(); // empty LID table
		const msg = withMentions(["999111@lid", "15551234567@s.whatsapp.net"]);
		// Only the resolvable phone-jid survives; the LID is dropped to avoid
		// false allow-list matches downstream.
		assert.deepEqual(await extractMentions(msg, sock), ["15551234567"]);
	});

	it("deduplicates mentions that resolve to the same canonical id", async () => {
		const sock = makeSock({ "111@lid": "15551234567@s.whatsapp.net" });
		const msg = withMentions(["15551234567@s.whatsapp.net", "111@lid", "15551234567:2@s.whatsapp.net"]);
		assert.deepEqual(await extractMentions(msg, sock), ["15551234567"]);
	});

	it("scans multiple envelope kinds (image / video / document captions)", async () => {
		const sock = makeSock();
		const msg = {
			imageMessage: {
				caption: "look here",
				contextInfo: { mentionedJid: ["15551234567@s.whatsapp.net"] },
			},
		} as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), ["15551234567"]);
	});
});

describe("extractReplyContext", () => {
	it("returns undefined when no contextInfo is present", async () => {
		const sock = makeSock();
		const msg = { conversation: "plain text" } as unknown as WAMessage["message"];
		assert.equal(await extractReplyContext(msg, sock), undefined);
	});

	it("returns undefined when contextInfo carries no quote / stanza / participant", async () => {
		const sock = makeSock();
		const msg = { extendedTextMessage: { text: "x", contextInfo: { mentionedJid: ["15551234567@s.whatsapp.net"] } } } as unknown as WAMessage["message"];
		assert.equal(await extractReplyContext(msg, sock), undefined);
	});

	it("captures stanzaId + quoted body + canonical sender", async () => {
		const sock = makeSock();
		const msg = withMentions([], {
			stanzaId: "ABCDEF1234",
			participant: "15551234567@s.whatsapp.net",
			body: "the original message",
		});
		const ctx = await extractReplyContext(msg, sock);
		assert.equal(ctx?.messageId, "ABCDEF1234");
		assert.equal(ctx?.body, "the original message");
		assert.equal(ctx?.from, "15551234567");
	});

	it("resolves a LID-aliased reply participant through the lookup table", async () => {
		const sock = makeSock({ "999@lid": "447700900123@s.whatsapp.net" });
		const msg = withMentions([], {
			stanzaId: "ID1",
			participant: "999@lid",
			body: "earlier message",
		});
		const ctx = await extractReplyContext(msg, sock);
		assert.equal(ctx?.from, "447700900123");
	});

	it("drops `from` (keeps body + messageId) when reply participant is an unresolvable LID", async () => {
		const sock = makeSock(); // empty LID table
		const msg = withMentions([], {
			stanzaId: "ID1",
			participant: "999@lid",
			body: "earlier",
		});
		const ctx = await extractReplyContext(msg, sock);
		assert.equal(ctx?.from, undefined, "from must be undefined for unresolvable LIDs (no fake id)");
		assert.equal(ctx?.messageId, "ID1");
		assert.equal(ctx?.body, "earlier");
	});

	it("truncates a long quoted body to 280 chars so context isn't gobbled", async () => {
		const sock = makeSock();
		const big = "x".repeat(1000);
		const msg = withMentions([], { stanzaId: "ID1", participant: "15551234567@s.whatsapp.net", body: big });
		const ctx = await extractReplyContext(msg, sock);
		assert.equal(ctx?.body?.length, 280);
	});
});

describe("envelope-wrapper unwrap (mentions inside ephemeral / view-once / document-with-caption)", () => {
	it("finds mentions inside an ephemeralMessage wrapper (disappearing chat)", async () => {
		const sock = makeSock();
		const msg = {
			ephemeralMessage: {
				message: withMentions(["15551234567@s.whatsapp.net"]),
			},
		} as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), ["15551234567"]);
	});

	it("finds mentions inside a viewOnceMessageV2 wrapper", async () => {
		const sock = makeSock();
		const msg = {
			viewOnceMessageV2: {
				message: withMentions(["447700900123@s.whatsapp.net"]),
			},
		} as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), ["447700900123"]);
	});

	it("finds mentions inside a documentWithCaptionMessage wrapper", async () => {
		const sock = makeSock();
		const msg = {
			documentWithCaptionMessage: {
				message: withMentions(["19998887777@s.whatsapp.net"]),
			},
		} as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), ["19998887777"]);
	});

	it("walks a doubly-wrapped envelope (ephemeral inside viewOnce)", async () => {
		const sock = makeSock();
		const msg = {
			viewOnceMessage: {
				message: {
					ephemeralMessage: {
						message: withMentions(["12223334444@s.whatsapp.net"]),
					},
				},
			},
		} as unknown as WAMessage["message"];
		assert.deepEqual(await extractMentions(msg, sock), ["12223334444"]);
	});

	it("reply context survives the wrapper unwrap too", async () => {
		const sock = makeSock();
		const msg = {
			ephemeralMessage: {
				message: withMentions([], {
					stanzaId: "ID-EPH",
					participant: "15551234567@s.whatsapp.net",
					body: "ephemeral reply body",
				}),
			},
		} as unknown as WAMessage["message"];
		const ctx = await extractReplyContext(msg, sock);
		assert.equal(ctx?.messageId, "ID-EPH");
		assert.equal(ctx?.body, "ephemeral reply body");
		assert.equal(ctx?.from, "15551234567");
	});
});
