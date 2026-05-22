import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Type } from "typebox";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import { loadModules } from "./loader.js";
import { BrigadeExtensionRegistry } from "./registry.js";
import { type ChannelAdapter, defineModule } from "./types.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

/** Minimal valid tool fake. */
function fakeTool(name: string): AnyBrigadeTool {
	return {
		name,
		label: name,
		description: "d",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	} as AnyBrigadeTool;
}

/** Minimal valid channel fake. */
function fakeChannel(id: string): ChannelAdapter {
	return {
		id,
		label: id,
		isConfigured: () => true,
		async start() {},
		async stop() {},
		async sendText() {},
	};
}

describe("BrigadeExtensionRegistry", () => {
	it("records agent-level + product-level registrations", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(fakeTool("ping"));
		b.channel(fakeChannel("wa"));
		b.tts({
			id: "el",
			label: "ElevenLabs",
			isConfigured: () => true,
			async synthesize() {
				return { audio: Buffer.from(""), mimeType: "audio/mpeg" };
			},
		});
		assert.deepEqual(reg.toolNames(), ["ping"]);
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.id, "wa");
		assert.equal(reg.speechProviders.length, 1);
	});

	it("product registrations dedupe by id (last wins)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.channel({ ...fakeChannel("wa"), label: "first" });
		b.channel({ ...fakeChannel("wa"), label: "second" });
		assert.equal(reg.channels.length, 1);
		assert.equal(reg.channels[0]?.label, "second");
	});

	it("eligible()=false gates a tool out of toolNames AND the Pi factory", () => {
		const reg = new BrigadeExtensionRegistry();
		reg.context(META).tool(fakeTool("off"), { eligible: () => false });
		assert.deepEqual(reg.toolNames(), []);
		const registered: string[] = [];
		const pi = { registerTool: (t: { name: string }) => registered.push(t.name), on() {}, registerCommand() {} };
		reg.toPiExtensionFactory()(pi as never);
		assert.deepEqual(registered, []);
	});

	it("toPiExtensionFactory replays tools + hooks + commands into the Pi API", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(fakeTool("ping"));
		b.hook("tool_result", () => {});
		b.command("hi", {});
		const tools: string[] = [];
		const events: string[] = [];
		const cmds: string[] = [];
		const pi = {
			registerTool: (t: { name: string }) => tools.push(t.name),
			on: (e: string) => events.push(e),
			registerCommand: (n: string) => cmds.push(n),
		};
		reg.toPiExtensionFactory()(pi as never);
		assert.deepEqual(tools, ["ping"]);
		assert.deepEqual(events, ["tool_result"]);
		assert.deepEqual(cmds, ["hi"]);
	});
});

describe("loadModules gating", () => {
	const channelMod = (id: string) => defineModule({ id, register: (b) => b.channel(fakeChannel(id)) });

	it("loads an enabled module", async () => {
		const reg = await loadModules({ modules: [channelMod("a")], meta: META });
		assert.equal(reg.channels.length, 1);
	});

	it("skips a module in extensions.disabled[]", async () => {
		const reg = await loadModules({
			modules: [channelMod("a")],
			meta: { ...META, config: { extensions: { disabled: ["a"] } } as unknown as BrigadeConfig },
		});
		assert.equal(reg.channels.length, 0);
	});

	it("skips everything when extensions.enabled === false", async () => {
		const reg = await loadModules({
			modules: [channelMod("a")],
			meta: { ...META, config: { extensions: { enabled: false } } as unknown as BrigadeConfig },
		});
		assert.equal(reg.channels.length, 0);
	});

	it("skips a module whose requiresEnv is missing", async () => {
		const mod = defineModule({ id: "b", requiresEnv: ["MISSING_XYZ_123"], register: (b) => b.channel(fakeChannel("b")) });
		const reg = await loadModules({ modules: [mod], meta: META, env: {} });
		assert.equal(reg.channels.length, 0);
	});

	it("a throwing module is skipped, not fatal", async () => {
		const boom = defineModule({
			id: "c",
			register() {
				throw new Error("boom");
			},
		});
		const reg = await loadModules({ modules: [boom, channelMod("d")], meta: META });
		assert.equal(reg.channels.length, 1); // d still loaded despite c throwing
	});
});
