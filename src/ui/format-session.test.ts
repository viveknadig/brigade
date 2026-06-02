/**
 * Pin-down tests for Brigade-style session label formatting.
 *
 * Each row asserts the canonical "what the operator sees in the TUI
 * header for this session key" — the design rules live in the
 * format-session.ts doc-comment and the table below should match the
 * README diff one-for-one.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatCrewLabel, formatSessionLabel } from "./format-session.js";

describe("formatSessionLabel — Brigade-style session chips", () => {
	it("omits the chip for the operator's home session (main agent)", () => {
		assert.equal(formatSessionLabel("agent:main:main"), undefined);
	});

	it("omits the chip for any agent's home session (crew badge carries it)", () => {
		assert.equal(formatSessionLabel("agent:ops:main"), undefined);
		assert.equal(formatSessionLabel("agent:work:main"), undefined);
	});

	it("returns undefined for empty / null keys", () => {
		assert.equal(formatSessionLabel(""), undefined);
		assert.equal(formatSessionLabel("   "), undefined);
		assert.equal(formatSessionLabel(null), undefined);
		assert.equal(formatSessionLabel(undefined), undefined);
	});

	it("renders WhatsApp DMs with the peer phone number", () => {
		assert.equal(
			formatSessionLabel("agent:main:whatsapp:direct:+919876543210"),
			"WhatsApp · +919876543210",
		);
	});

	it("renders Slack groups with the channel id (lowercased by the key builder)", () => {
		// Brigade canonicalises session keys to lowercase at build time, so the
		// raw channel id `C012ABC` becomes `c012abc` by the time it reaches
		// the formatter. We render whatever's in the key — preserving the
		// canonical form is the simplest contract.
		assert.equal(formatSessionLabel("agent:ops:slack:group:c012abc"), "Slack · c012abc");
	});

	it("renders Telegram channels with the @handle intact", () => {
		assert.equal(formatSessionLabel("agent:work:telegram:channel:@news"), "Telegram · @news");
	});

	it("renders Discord guild/peer combos in title case", () => {
		assert.equal(
			formatSessionLabel("agent:main:discord:direct:user-12345"),
			"Discord · user-12345",
		);
	});

	it("appends a thread arrow when the key carries a :thread: suffix", () => {
		assert.equal(
			formatSessionLabel("agent:ops:whatsapp:group:c1:thread:t42"),
			"WhatsApp · c1 ⤳ t42",
		);
	});

	it("shortens long peer ids with an ellipsis", () => {
		assert.equal(
			formatSessionLabel("agent:main:slack:direct:u1234567890abcdefghijklmnopqrstuvwxyz"),
			"Slack · u1234567890abcdefghijkl…",
		);
	});

	it("formats sub-agents with the ↳ cub framing", () => {
		assert.equal(
			formatSessionLabel("agent:main:subagent:abc-def-1234"),
			"↳ cub abc-def…",
		);
	});

	it("formats cron-triggered turns with the ⏰ emoji", () => {
		assert.equal(
			formatSessionLabel("agent:main:cron:morning-summary"),
			"⏰ morning-summary",
		);
	});

	it("handles per-account-channel-peer shape (4-part rest)", () => {
		assert.equal(
			formatSessionLabel("agent:ops:slack:workspace-1:group:c012abc"),
			"Slack · c012abc",
		);
	});

	it("falls back to the raw key when parsing fails", () => {
		assert.equal(formatSessionLabel("not-a-session-key"), "not-a-session-key");
	});

	it("passes through a custom single-token alias as-is", () => {
		assert.equal(formatSessionLabel("agent:main:custom"), "custom");
	});
});

describe("formatCrewLabel — Brigade crew badge", () => {
	it("hides the badge when the operator is on the default agent with a persona set", () => {
		assert.equal(formatCrewLabel({ agentId: "main", personaName: "felix" }), "");
	});

	it("shows `crew main` when the operator is on the default agent without a persona", () => {
		assert.equal(formatCrewLabel({ agentId: "main", personaName: undefined }), "crew main");
		assert.equal(formatCrewLabel({ agentId: "main", personaName: "" }), "crew main");
	});

	it("shows `crew <id>` for non-default agents regardless of persona", () => {
		assert.equal(formatCrewLabel({ agentId: "ops", personaName: "skye" }), "crew ops");
		assert.equal(formatCrewLabel({ agentId: "work", personaName: undefined }), "crew work");
	});

	it("returns empty string for missing agent id", () => {
		assert.equal(formatCrewLabel({ agentId: "", personaName: "felix" }), "");
		assert.equal(formatCrewLabel({ agentId: undefined, personaName: "felix" }), "");
		assert.equal(formatCrewLabel({ agentId: null, personaName: "felix" }), "");
	});
});
