/**
 * resolveSessionAccessPolicy tests.
 *
 * Pins the derivation extracted from agent-loop (2026-06-11) so the per-turn
 * build and the sessions_send live re-check stay identical, and pins the
 * mid-run-enable behavior the live re-check restores: a config that flips
 * from blocked → allowed must produce a policy that grants the send.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveSessionAccessPolicy } from "./resolve-access.js";
import { checkSessionToolAccess } from "./shared.js";

const MAIN = "agent:main:main";
const ML = "agent:marketing-lead:main";

function canSend(cfg: unknown): boolean {
	const { visibility, a2aPolicy } = resolveSessionAccessPolicy(cfg);
	return checkSessionToolAccess({
		action: "send",
		requesterSessionKey: MAIN,
		targetSessionKey: ML,
		visibility,
		a2aPolicy,
	}).allowed;
}

describe("resolveSessionAccessPolicy — derivation", () => {
	it("defaults (empty config) → visibility self, A2A disabled, send blocked", () => {
		const { visibility, a2aPolicy } = resolveSessionAccessPolicy({});
		assert.equal(visibility, "self");
		assert.equal(a2aPolicy.enabled, false);
		assert.equal(canSend({}), false);
	});

	it("flat allow-all + visibility all + enabled (no org) → send allowed", () => {
		const cfg = {
			session: {
				sessionTools: { visibility: "all" },
				agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
			},
		};
		assert.equal(canSend(cfg), true);
	});

	it("org derived mode blocks a non-member orchestrator (main not in graph)", () => {
		const cfg = {
			session: {
				sessionTools: { visibility: "all" },
				agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
			},
			org: {
				topOrder: "ceo-agent",
				a2a: { mode: "derived" },
				// main is NOT a member; marketing-lead reports to cmo-agent.
			},
			agents: {
				"ceo-agent": { org: { department: "exec", reportsTo: null } },
				"cmo-agent": { org: { department: "marketing", reportsTo: "ceo-agent" } },
				"marketing-lead": { org: { department: "marketing", reportsTo: "cmo-agent" } },
			},
		};
		assert.equal(canSend(cfg), false, "derived mode: main (non-member) cannot reach marketing-lead");
	});

	it("THE FIX: flipping that same org to explicit mode → send now allowed", () => {
		// Exactly the mid-run manage_access change: derived → explicit. Under
		// explicit the org graph is bypassed and the flat allow matrix
		// (everyone↔everyone) applies, so main reaches marketing-lead.
		const base = {
			session: {
				sessionTools: { visibility: "all" },
				agentToAgent: { enabled: true, allow: [{ from: "*", to: "*" }] },
			},
			agents: {
				"ceo-agent": { org: { department: "exec", reportsTo: null } },
				"marketing-lead": { org: { department: "marketing", reportsTo: "ceo-agent" } },
			},
		};
		const derived = { ...base, org: { topOrder: "ceo-agent", a2a: { mode: "derived" } } };
		const explicit = { ...base, org: { topOrder: "ceo-agent", a2a: { mode: "explicit" } } };
		assert.equal(canSend(derived), false, "before: derived blocks main");
		assert.equal(canSend(explicit), true, "after manage_access set explicit: allowed");
	});
});
