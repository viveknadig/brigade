/**
 * Locks the BOOTSTRAP-nudge gate: the operator-onboarding ritual must NOT
 * fire for non-operator peers (approved friends DMing the bot). This was a
 * real production-visible bug where a newly-approved friend's first message
 * triggered the "Hey. I just came online. Who am I? Who are you?" intro
 * meant for the operator alone.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveEffectiveBootstrapPhase } from "./agent-loop.js";

describe("resolveEffectiveBootstrapPhase", () => {
	it("operator's FIRST turn on a fresh workspace → keeps `first-turn` (intro fires)", () => {
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "first-turn",
				sessionAlreadyHasBootstrap: false,
				senderIsOwner: true,
			}),
			"first-turn",
		);
	});

	it("operator's CONTINUING turn (same session) → in-progress (no re-nudge)", () => {
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "first-turn",
				sessionAlreadyHasBootstrap: true,
				senderIsOwner: true,
			}),
			"in-progress",
		);
	});

	it("APPROVED PEER (non-owner) on a workspace still in first-turn → in-progress (NO operator-onboarding for peers)", () => {
		// THIS is the regression-lock for the user-reported bug: a friend
		// approved via `pairing approve` was getting "Hey. I just came
		// online. Who am I? Who are you?" — meant for the operator alone.
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "first-turn",
				sessionAlreadyHasBootstrap: false,
				senderIsOwner: false,
			}),
			"in-progress",
		);
	});

	it("APPROVED PEER (non-owner) on a fresh session and a completed workspace → still in-progress (never first-turn for peers)", () => {
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "first-turn",
				sessionAlreadyHasBootstrap: true,
				senderIsOwner: false,
			}),
			"in-progress",
		);
	});

	it("workspace in-progress → operator sees in-progress (continuing flow)", () => {
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "in-progress",
				sessionAlreadyHasBootstrap: false,
				senderIsOwner: true,
			}),
			"in-progress",
		);
	});

	it("workspace complete → both operator and peers see `complete` (mature workspace, no intro for anyone)", () => {
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "complete",
				sessionAlreadyHasBootstrap: false,
				senderIsOwner: true,
			}),
			"complete",
		);
		assert.equal(
			resolveEffectiveBootstrapPhase({
				workspacePhase: "complete",
				sessionAlreadyHasBootstrap: false,
				senderIsOwner: false,
			}),
			"complete",
		);
	});

	it("peer-gate beats workspace-state: even a fresh-workspace first-session peer turn collapses", () => {
		// Defensive case: regardless of any combination of workspace +
		// session state, a non-owner ALWAYS gets in-progress. This is the
		// single-line invariant the gate exists to enforce.
		for (const workspacePhase of ["first-turn", "in-progress", "complete"] as const) {
			for (const sessionAlreadyHasBootstrap of [true, false]) {
				const result = resolveEffectiveBootstrapPhase({
					workspacePhase,
					sessionAlreadyHasBootstrap,
					senderIsOwner: false,
				});
				assert.notEqual(
					result,
					"first-turn",
					`non-owner must never see first-turn (workspace=${workspacePhase}, sessionHas=${sessionAlreadyHasBootstrap})`,
				);
			}
		}
	});
});
