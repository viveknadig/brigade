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

describe("assembleSystemPrompt — inline guidance (Safety + Interaction Style)", () => {
	// At commit c1894db (verified working with gpt-5.4) the assembler
	// emitted just THREE short inline blocks: Safety, Interaction Style,
	// Tooling. The 6-block guidance composition added in a7db967 was
	// found to overconstrain first-turn replies. The simple inline blocks
	// are what the model actually responds well to — the BOOTSTRAP.md
	// signal stays dominant.
	it("includes inline Safety + Interaction Style sections", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Safety/);
		assert.match(out.text, /## Interaction Style/);
		assert.match(out.text, /Decline requests that would compromise/);
		assert.match(out.text, /start doing it. Skip preambles/);
	});

	it("does NOT inject the 6-block guidance composition", () => {
		// Sanity: the larger guidance blocks (`# Safety baseline`, `# Tool-use
		// discipline`, etc.) must NOT appear. Their constants still live in
		// guidance.ts but the assembler doesn't import them.
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "gpt-4o",
			thinkingLevel: "high",
		});
		assert.doesNotMatch(out.text, /# Safety baseline/);
		assert.doesNotMatch(out.text, /# Execution bias/);
		assert.doesNotMatch(out.text, /# Tool-call style/);
		assert.doesNotMatch(out.text, /# Tool-use discipline/);
		assert.doesNotMatch(out.text, /# Reasoning format/);
		assert.doesNotMatch(out.text, /Execution discipline \(extra\)/);
		assert.doesNotMatch(out.text, /Operational directives \(extra\)/);
	});

	it("inline Safety sits above the cache boundary (stays in cached prefix)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const safetyIdx = out.text.indexOf("## Safety");
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		assert.ok(safetyIdx > 0, "Safety section must be in the output");
		assert.ok(boundaryIdx > 0, "cache boundary must be in the output");
		assert.ok(safetyIdx < boundaryIdx, "Safety MUST sit above the cache boundary");
	});
});

describe("assembleSystemPrompt — no `<think>` tag instructions (any model)", () => {
	it("never mentions <think> tags regardless of model + thinking level", () => {
		for (const modelId of ["claude-opus-4-7", "gemini-2.5-pro", "gpt-4o", "o3-mini", "custom-7b"]) {
			for (const thinkingLevel of ["off", "low", "medium", "high"]) {
				const out = assembleSystemPrompt({
					runtime: MOCK_RUNTIME,
					personaFiles: [],
					toolDescriptions: [],
					modelId,
					thinkingLevel,
				});
				assert.doesNotMatch(
					out.text,
					/<think>/,
					`should not mention <think> tags for ${modelId} thinking=${thinkingLevel}`,
				);
			}
		}
	});
});

describe("assembleSystemPrompt — capabilities flag is accepted but ignored", () => {
	// The `capabilities` arg still threads through (so callers don't break);
	// the corresponding guidance blocks just aren't injected today. They
	// stay in guidance.ts for future re-enable.
	it("does NOT inject Memory/Skills/Crew blocks even when capabilities=true", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			capabilities: { memory: true, skills: true, subAgents: true },
		});
		assert.doesNotMatch(out.text, /# Memory/);
		assert.doesNotMatch(out.text, /# Skills/);
		assert.doesNotMatch(out.text, /# Crew coordination/);
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
