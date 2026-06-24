import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChannelCommand } from "../../extensions/types.js";
import { buildDiscordCommandManifest, normalizeDiscordCommandName } from "./command-menu.js";

const cmd = (name: string, description?: string): ChannelCommand => ({
	name,
	...(description !== undefined ? { description } : {}),
	handler: () => "",
});

describe("normalizeDiscordCommandName", () => {
	it("strips a leading slash + lowercases", () => {
		assert.equal(normalizeDiscordCommandName("/Help"), "help");
		assert.equal(normalizeDiscordCommandName("STATUS"), "status");
	});

	it("keeps [a-z0-9_-] and drops the rest", () => {
		assert.equal(normalizeDiscordCommandName("my-cmd!"), "my-cmd");
		assert.equal(normalizeDiscordCommandName("agent_2"), "agent_2");
	});

	it("returns null for an empty / fully-invalid name", () => {
		assert.equal(normalizeDiscordCommandName("///"), null);
		assert.equal(normalizeDiscordCommandName("   "), null);
	});

	it("clamps to 32 chars", () => {
		assert.equal(normalizeDiscordCommandName("a".repeat(40))?.length, 32);
	});
});

describe("buildDiscordCommandManifest", () => {
	it("maps central commands to CHAT_INPUT {name, description, type}", () => {
		const menu = buildDiscordCommandManifest([cmd("help", "Show help"), cmd("status", "Show status")]);
		assert.deepEqual(menu, [
			{ name: "help", description: "Show help", type: 1 },
			{ name: "status", description: "Show status", type: 1 },
		]);
	});

	it("de-dupes by normalized name (first wins)", () => {
		const menu = buildDiscordCommandManifest([cmd("Help"), cmd("/help", "dup")]);
		assert.equal(menu.length, 1);
		assert.equal(menu[0]?.name, "help");
	});

	it("falls back to the name when no description is given (never empty)", () => {
		assert.equal(buildDiscordCommandManifest([cmd("whoami")])[0]?.description, "whoami");
	});

	it("clamps a long description to 100 chars", () => {
		const menu = buildDiscordCommandManifest([cmd("x", "d".repeat(200))]);
		assert.ok((menu[0]?.description.length ?? 0) <= 100);
	});

	it("drops unusable command names", () => {
		assert.deepEqual(buildDiscordCommandManifest([cmd("///"), cmd("help", "ok")]), [
			{ name: "help", description: "ok", type: 1 },
		]);
	});

	it("caps at 100 commands", () => {
		const many = Array.from({ length: 150 }, (_v, i) => cmd(`cmd_${i}`, "x"));
		assert.equal(buildDiscordCommandManifest(many).length, 100);
	});
});
