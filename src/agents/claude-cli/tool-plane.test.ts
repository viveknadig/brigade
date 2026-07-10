import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildClaudeCliHttpMcpConfig,
	buildClaudeCliMcpConfig,
	readClaudeCliToolPlane,
	stampClaudeCliToolPlane,
} from "./tool-plane.js";

const TOKEN = "a".repeat(64);

test("stamp/read round-trips on a plain context object", () => {
	const ctx: Record<string, unknown> = { systemPrompt: "x", messages: [] };
	stampClaudeCliToolPlane(ctx, { agentId: "main", senderIsOwner: true });
	assert.deepEqual(readClaudeCliToolPlane(ctx), { agentId: "main", senderIsOwner: true });
});

test("read: unstamped / malformed contexts yield undefined", () => {
	assert.equal(readClaudeCliToolPlane({}), undefined);
	assert.equal(readClaudeCliToolPlane(undefined), undefined);
	assert.equal(readClaudeCliToolPlane(null), undefined);
	assert.equal(readClaudeCliToolPlane("nope"), undefined);
	const bad: Record<string, unknown> = {};
	stampClaudeCliToolPlane(bad, { agentId: "", senderIsOwner: true } as never);
	assert.equal(readClaudeCliToolPlane(bad), undefined, "empty agentId rejected");
});

test("read: peer stamp preserves senderIsOwner=false (the isolation signal)", () => {
	const ctx: Record<string, unknown> = {};
	stampClaudeCliToolPlane(ctx, { agentId: "main", senderIsOwner: false });
	assert.equal(readClaudeCliToolPlane(ctx)?.senderIsOwner, false);
});

test("stamp: non-object / frozen contexts are a safe no-op (fail-open)", () => {
	assert.doesNotThrow(() => stampClaudeCliToolPlane(undefined, { agentId: "a", senderIsOwner: true }));
	assert.doesNotThrow(() => stampClaudeCliToolPlane("s", { agentId: "a", senderIsOwner: true }));
	const frozen = Object.freeze({} as Record<string, unknown>);
	assert.doesNotThrow(() => stampClaudeCliToolPlane(frozen, { agentId: "a", senderIsOwner: true }));
	assert.equal(readClaudeCliToolPlane(frozen), undefined, "no stamp => tool-less, not a broken turn");
});

test("buildClaudeCliMcpConfig: points the `brigade` server at our own CLI entry", () => {
	const json = buildClaudeCliMcpConfig("main");
	assert.ok(json, "config built (argv[1] present under the test runner)");
	const cfg = JSON.parse(json as string) as {
		mcpServers: { brigade: { command: string; args: string[]; env?: Record<string, string> } };
	};
	const srv = cfg.mcpServers.brigade;
	assert.equal(srv.command, process.execPath, "runs under the same node");
	assert.equal(srv.args[0], process.argv[1], "same entry as this process");
	assert.deepEqual(srv.args.slice(1), ["mcp", "--agent", "main"]);
});

test("buildClaudeCliMcpConfig: forwards BRIGADE_STATE_DIR so the child resolves the same store", () => {
	const prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = "X:\\some\\state";
	try {
		const cfg = JSON.parse(buildClaudeCliMcpConfig("main") as string) as {
			mcpServers: { brigade: { env?: Record<string, string> } };
		};
		assert.equal(cfg.mcpServers.brigade.env?.BRIGADE_STATE_DIR, "X:\\some\\state");
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prev;
	}
});

test("buildClaudeCliMcpConfig: unsafe agent ids fail OPEN (undefined, no config)", () => {
	assert.equal(buildClaudeCliMcpConfig("../evil"), undefined);
	assert.equal(buildClaudeCliMcpConfig("a b"), undefined);
	assert.equal(buildClaudeCliMcpConfig('x";rm -rf'), undefined);
	assert.equal(buildClaudeCliMcpConfig(""), undefined);
});

/* ─────────────────────── full-plane HTTP config (P2) ─────────────────────── */

test("buildClaudeCliHttpMcpConfig: emits an {type:http,url} server for a valid loopback URL", () => {
	const json = buildClaudeCliHttpMcpConfig(`http://127.0.0.1:7777/mcp/${TOKEN}`);
	assert.ok(json);
	const cfg = JSON.parse(json as string);
	assert.equal(cfg.mcpServers.brigade.type, "http");
	assert.equal(cfg.mcpServers.brigade.url, `http://127.0.0.1:7777/mcp/${TOKEN}`);
});

test("buildClaudeCliHttpMcpConfig: refuses non-loopback / malformed URLs (fail-open)", () => {
	assert.equal(buildClaudeCliHttpMcpConfig(`http://8.8.8.8:7777/mcp/${TOKEN}`), undefined, "never off-host");
	assert.equal(buildClaudeCliHttpMcpConfig(`https://127.0.0.1/mcp/${TOKEN}`), undefined, "https not emitted");
	assert.equal(buildClaudeCliHttpMcpConfig("http://127.0.0.1:7777/mcp/short"), undefined);
	assert.equal(buildClaudeCliHttpMcpConfig("http://127.0.0.1:7777/evil"), undefined);
	assert.equal(buildClaudeCliHttpMcpConfig(""), undefined);
});

test("stamp/read carries mcpHttpUrl (the full-plane signal) when present", () => {
	const url = `http://127.0.0.1:7777/mcp/${TOKEN}`;
	const ctx: Record<string, unknown> = {};
	stampClaudeCliToolPlane(ctx, { agentId: "main", senderIsOwner: true, mcpHttpUrl: url });
	assert.equal(readClaudeCliToolPlane(ctx)?.mcpHttpUrl, url);
	// absent by default (memory-only stdio path)
	const ctx2: Record<string, unknown> = {};
	stampClaudeCliToolPlane(ctx2, { agentId: "main", senderIsOwner: true });
	assert.equal(readClaudeCliToolPlane(ctx2)?.mcpHttpUrl, undefined);
});
