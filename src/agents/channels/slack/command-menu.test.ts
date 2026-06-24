import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChannelCommand } from "../../extensions/types.js";
import { buildSlackCommandManifest, normalizeSlackCommandName } from "./command-menu.js";

const cmd = (name: string, description?: string): ChannelCommand => ({
	name,
	...(description !== undefined ? { description } : {}),
	handler: () => "",
});

describe("normalizeSlackCommandName", () => {
	it("strips a leading slash + lowercases", () => {
		assert.equal(normalizeSlackCommandName("/Help"), "help");
		assert.equal(normalizeSlackCommandName("STATUS"), "status");
	});

	it("keeps [a-z0-9_-] and drops the rest", () => {
		assert.equal(normalizeSlackCommandName("my-cmd!"), "my-cmd");
		assert.equal(normalizeSlackCommandName("agent_2"), "agent_2");
	});

	it("returns null for an empty / fully-invalid name", () => {
		assert.equal(normalizeSlackCommandName("///"), null);
		assert.equal(normalizeSlackCommandName("   "), null);
	});

	it("clamps to 32 chars", () => {
		assert.equal(normalizeSlackCommandName("a".repeat(40))?.length, 32);
	});
});

describe("buildSlackCommandManifest", () => {
	it("maps central commands to {command, description}", () => {
		const menu = buildSlackCommandManifest([cmd("help", "Show help"), cmd("status", "Show status")]);
		assert.deepEqual(menu, [
			{ command: "help", description: "Show help" },
			{ command: "status", description: "Show status" },
		]);
	});

	it("de-dupes by normalized name (first wins)", () => {
		const menu = buildSlackCommandManifest([cmd("Help"), cmd("/help", "dup")]);
		assert.equal(menu.length, 1);
		assert.equal(menu[0]?.command, "help");
	});

	it("falls back to the name when no description is given", () => {
		assert.equal(buildSlackCommandManifest([cmd("whoami")])[0]?.description, "whoami");
	});

	it("drops unusable command names", () => {
		assert.deepEqual(buildSlackCommandManifest([cmd("///"), cmd("help", "ok")]), [
			{ command: "help", description: "ok" },
		]);
	});

	it("caps at 100 commands", () => {
		const many = Array.from({ length: 150 }, (_v, i) => cmd(`cmd_${i}`, "x"));
		assert.equal(buildSlackCommandManifest(many).length, 100);
	});
});
