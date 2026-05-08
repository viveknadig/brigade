import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { assembleSystemPrompt } from "./assembler.js";
import { CACHE_BOUNDARY_MARKER_LINE } from "./cache-boundary.js";

const MOCK_RUNTIME = {
	agentId: "default",
	workspaceDir: "/mock/workspace",
	cwd: "/mock/cwd",
	hostName: "test-host",
	platform: "linux" as NodeJS.Platform,
	arch: "x64",
	nodeVersion: "v22.12.0",
	shell: "/bin/bash",
	modelLabel: "anthropic/claude-opus-4-7",
	channelLabel: "cli",
	thinkingLevel: "off",
	timezone: "UTC",
	nowIso: "2026-05-08T00:00:00.000Z",
	repoRoot: undefined,
};

describe("assembleSystemPrompt — always-on guidance always present", () => {
	it("includes Safety / Execution / Tool-call style / Tool-use enforcement", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /# Safety baseline/);
		assert.match(out.text, /# Execution bias/);
		assert.match(out.text, /# Tool-call style/);
		assert.match(out.text, /# Tool-use discipline/);
	});

	it("Tool-use discipline appears BEFORE the cache boundary (cached prefix)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const enforceIdx = out.text.indexOf("# Tool-use discipline");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(enforceIdx > 0, "tool-use enforcement must be in the output");
		assert.ok(boundaryIdx > 0, "cache boundary must be in the output");
		assert.ok(
			enforceIdx < boundaryIdx,
			"tool-use enforcement MUST sit above the cache boundary or it busts the prefix",
		);
	});
});

describe("assembleSystemPrompt — reasoning format gating", () => {
	it("omits reasoning format for Claude with thinking=high (native extended thinking)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "claude-opus-4-7",
			thinkingLevel: "high",
		});
		assert.doesNotMatch(out.text, /# Reasoning format/);
	});

	it("includes reasoning format for Gemini with thinking=high", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "gemini-2.5-pro",
			thinkingLevel: "high",
		});
		assert.match(out.text, /# Reasoning format/);
	});

	it("omits reasoning format when thinking=off regardless of model", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "gemini-2.5-pro",
			thinkingLevel: "off",
		});
		assert.doesNotMatch(out.text, /# Reasoning format/);
	});
});

describe("assembleSystemPrompt — per-family guidance", () => {
	it("OpenAI family gets the verbose execution-discipline block", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "gpt-4o",
			thinkingLevel: "off",
		});
		assert.match(out.text, /Execution discipline \(extra\)/);
		assert.match(out.text, /never mental math/);
	});

	it("Google family gets path-absolutism + parallel-tool guidance", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "gemini-2.5-pro",
			thinkingLevel: "off",
		});
		assert.match(out.text, /Operational directives \(extra\)/);
		assert.match(out.text, /ABSOLUTE file paths/);
	});

	it("Claude gets no per-family extras", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "claude-opus-4-7",
			thinkingLevel: "off",
		});
		assert.doesNotMatch(out.text, /Execution discipline \(extra\)/);
		assert.doesNotMatch(out.text, /Operational directives \(extra\)/);
	});

	it("aggregator-prefixed model id resolves correctly", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "openrouter/openai/gpt-4o",
			thinkingLevel: "off",
		});
		assert.match(out.text, /Execution discipline \(extra\)/);
	});
});

describe("assembleSystemPrompt — capability gates", () => {
	it("omits all capability blocks when capabilities is empty / undefined", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.doesNotMatch(out.text, /# Memory\n/);
		assert.doesNotMatch(out.text, /# Skills\n/);
		assert.doesNotMatch(out.text, /# Crew coordination/);
	});

	it("memory=true adds Memory guidance", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { memory: true },
		});
		assert.match(out.text, /# Memory/);
	});

	it("skills=true adds Skills guidance", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { skills: true },
		});
		assert.match(out.text, /# Skills/);
	});

	it("subAgents=true adds Crew coordination guidance", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { subAgents: true },
		});
		assert.match(out.text, /# Crew coordination/);
	});

	it("all capabilities=true adds all three blocks", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { memory: true, skills: true, subAgents: true },
		});
		assert.match(out.text, /# Memory/);
		assert.match(out.text, /# Skills/);
		assert.match(out.text, /# Crew coordination/);
	});
});

describe("assembleSystemPrompt — ephemeral suffix", () => {
	it("ephemeralSuffix lands BELOW the cache boundary (not cached)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
			ephemeralSuffix: "Sub-agent task: review the diff.",
		});
		const ephIdx = out.text.indexOf("Sub-agent task: review the diff.");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(ephIdx > 0, "ephemeral suffix must appear in the output");
		assert.ok(boundaryIdx > 0);
		assert.ok(
			ephIdx > boundaryIdx,
			"ephemeralSuffix MUST appear AFTER the cache boundary or it busts the prefix",
		);
	});

	it("empty / whitespace ephemeralSuffix is omitted entirely", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			ephemeralSuffix: "   ",
		});
		assert.doesNotMatch(out.text, /# Per-turn Notes/);
	});

	it("non-empty ephemeralSuffix renders under the Per-turn Notes header", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			ephemeralSuffix: "do the thing",
		});
		assert.match(out.text, /# Per-turn Notes/);
		assert.match(out.text, /do the thing/);
	});
});

describe("assembleSystemPrompt — tool listing", () => {
	it("empty tool list emits permissive line", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /Tools are wired into this turn/);
	});

	it("non-empty tool list emits each tool by name + summary", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [
				{ name: "read", summary: "Read a file" },
				{ name: "bash", summary: "Run a shell command" },
			],
		});
		assert.match(out.text, /Tool availability/);
		assert.match(out.text, /Tool names are case-sensitive/);
		assert.match(out.text, /- read: Read a file/);
		assert.match(out.text, /- bash: Run a shell command/);
	});
});
