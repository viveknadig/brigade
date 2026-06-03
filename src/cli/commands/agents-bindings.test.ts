import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BindingEntry, BrigadeConfig } from "../../config/io.js";
import {
	applyAgentBindings,
	describeBinding,
	listRouteBindings,
	parseBindingSpecs,
	removeAgentBindings,
} from "./agents-bindings.js";

describe("agents-bindings: describeBinding", () => {
	it("formats a channel-only binding", () => {
		assert.equal(describeBinding({ agentId: "main", match: { channel: "whatsapp" } }), "whatsapp");
	});
	it("appends accountId / peer / guild / team / roles when present", () => {
		const desc = describeBinding({
			agentId: "main",
			match: {
				channel: "discord",
				accountId: "acct-1",
				peer: { kind: "group", id: "g-7" },
				guildId: "guild-99",
				teamId: "team-12",
				roles: ["mod", "ops"],
			},
		});
		assert.match(desc, /discord/);
		assert.match(desc, /accountId=acct-1/);
		assert.match(desc, /peer=group:g-7/);
		assert.match(desc, /guild=guild-99/);
		assert.match(desc, /team=team-12/);
		assert.match(desc, /roles=mod,ops/);
	});
});

describe("agents-bindings: parseBindingSpecs", () => {
	const cfg: BrigadeConfig = { agents: {} };

	it("parses a bare channel spec", () => {
		const { bindings, errors } = parseBindingSpecs({ agentId: "main", specs: ["whatsapp"], config: cfg });
		assert.equal(errors.length, 0);
		assert.equal(bindings.length, 1);
		assert.equal(bindings[0]?.match?.channel, "whatsapp");
		assert.equal(bindings[0]?.match?.accountId, undefined);
	});

	it("parses channel:account specs", () => {
		const { bindings, errors } = parseBindingSpecs({
			agentId: "main",
			specs: ["whatsapp:acct-1"],
			config: cfg,
		});
		assert.equal(errors.length, 0);
		assert.equal(bindings[0]?.match?.accountId, "acct-1");
	});

	it("flags an empty account id", () => {
		const { bindings, errors } = parseBindingSpecs({ agentId: "main", specs: ["whatsapp:"], config: cfg });
		assert.equal(bindings.length, 0);
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /empty account id/);
	});

	it("flags an unknown channel when a catalog is supplied", () => {
		const { bindings, errors } = parseBindingSpecs({
			agentId: "main",
			specs: ["telnet"],
			config: cfg,
			channels: [{ id: "whatsapp" }],
		});
		assert.equal(bindings.length, 0);
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /Unknown channel/);
	});

	it("skips empty / whitespace specs silently", () => {
		const { bindings, errors } = parseBindingSpecs({
			agentId: "main",
			specs: ["", "  ", "whatsapp"],
			config: cfg,
		});
		assert.equal(errors.length, 0);
		assert.equal(bindings.length, 1);
	});
});

describe("agents-bindings: applyAgentBindings", () => {
	it("adds a brand-new binding", () => {
		const cfg: BrigadeConfig = { agents: {} };
		const result = applyAgentBindings(cfg, [{ agentId: "main", match: { channel: "whatsapp" } }]);
		assert.equal(result.added.length, 1);
		assert.equal(result.skipped.length, 0);
		assert.equal(result.conflicts.length, 0);
		assert.equal(result.config.bindings?.entries?.length, 1);
	});

	it("skips a duplicate (same agent + key)", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const result = applyAgentBindings(cfg, [{ agentId: "main", match: { channel: "whatsapp" } }]);
		assert.equal(result.skipped.length, 1);
		assert.equal(result.added.length, 0);
		assert.equal(result.config.bindings?.entries?.length, 1);
	});

	it("reports a conflict when a different agent owns the key", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const result = applyAgentBindings(cfg, [{ agentId: "scout", match: { channel: "whatsapp" } }]);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.added.length, 0);
		assert.equal(result.conflicts[0]?.existingAgentId, "main");
	});

	it("upgrades an unscoped same-agent binding to add an accountId", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const result = applyAgentBindings(cfg, [
			{ agentId: "main", match: { channel: "whatsapp", accountId: "acct-1" } },
		]);
		assert.equal(result.updated.length, 1);
		assert.equal(result.added.length, 0);
		assert.equal(result.config.bindings?.entries?.[0]?.match?.accountId, "acct-1");
	});
});

describe("agents-bindings: removeAgentBindings", () => {
	it("removes a matching binding", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const result = removeAgentBindings(cfg, [{ agentId: "main", match: { channel: "whatsapp" } }]);
		assert.equal(result.removed.length, 1);
		assert.equal(result.missing.length, 0);
		assert.equal(result.config.bindings?.entries?.length, 0);
	});

	it("reports missing when no key matches", () => {
		const cfg: BrigadeConfig = { agents: {}, bindings: { entries: [] } };
		const result = removeAgentBindings(cfg, [{ agentId: "main", match: { channel: "whatsapp" } }]);
		assert.equal(result.removed.length, 0);
		assert.equal(result.missing.length, 1);
	});

	it("reports a conflict when key matches but agent differs", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const result = removeAgentBindings(cfg, [{ agentId: "scout", match: { channel: "whatsapp" } }]);
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.removed.length, 0);
	});
});

describe("agents-bindings: listRouteBindings", () => {
	it("returns [] for missing bindings", () => {
		const cfg: BrigadeConfig = { agents: {} };
		const items: BindingEntry[] = listRouteBindings(cfg);
		assert.deepEqual(items, []);
	});

	it("returns the array when present", () => {
		const cfg: BrigadeConfig = {
			agents: {},
			bindings: { entries: [{ agentId: "main", match: { channel: "whatsapp" } }] },
		};
		const items = listRouteBindings(cfg);
		assert.equal(items.length, 1);
	});
});
