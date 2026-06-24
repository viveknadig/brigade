import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/types.js";
import { BrigadeExtensionRegistry } from "../../extensions/registry.js";
import { discordModule } from "./module.js";

const META_BASE = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd" };

/** Build a real `b` whose registrations land in the registry. */
function contextFor(config: unknown) {
	const reg = new BrigadeExtensionRegistry();
	const b = reg.context({ ...META_BASE, config: config as BrigadeConfig });
	return { reg, b };
}

describe("discordModule.register", () => {
	it("registers the Discord channel adapter", () => {
		const { reg, b } = contextFor({ channels: { discord: { enabled: true, botToken: "tok-A" } } });
		void discordModule.register(b);
		const ids = reg.channels.map((c) => c.id);
		assert.ok(ids.includes("discord"), `discord adapter must register: ${ids.join(",")}`);
	});

	it("registers NO http route (Gateway is the only inbound transport)", () => {
		const { reg, b } = contextFor({ channels: { discord: { enabled: true, botToken: "tok-A" } } });
		void discordModule.register(b);
		assert.equal(reg.httpRoutes.length, 0);
	});

	it("has the canonical module id", () => {
		assert.equal(discordModule.id, "discord");
	});
});
