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

describe("assembleSystemPrompt — universal sections (OpenClaw mirror order)", () => {
	it("emits the OpenClaw-mirrored section sequence in the right order", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const order = [
			"## Tooling",
			"## Tool Call Style",
			"## Execution Bias",
			"## Safety",
			"## Brigade CLI Quick Reference",
			"## Workspace",
			"# Project Context",
			CACHE_BOUNDARY_MARKER_LINE,
			"## Runtime",
		];
		let lastIdx = -1;
		for (const marker of order) {
			const idx = out.text.indexOf(marker);
			assert.ok(idx > lastIdx, `${marker} should appear AFTER the previous section`);
			lastIdx = idx;
		}
	});

	it("Tool Call Style block carries the narration + sensitive-action rules", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Tool Call Style/);
		assert.match(out.text, /do not narrate routine, low-risk tool calls/i);
		assert.match(out.text, /sensitive actions/i);
		// New OpenClaw-lifted lines that were previously missing.
		assert.match(out.text, /Keep narration brief and value-dense/i);
		assert.match(out.text, /When a first-class tool exists/i);
	});

	it("Execution Bias block tells the model to start doing it", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Execution Bias/);
		assert.match(out.text, /start doing it/);
		assert.match(out.text, /Match response length to the question/);
	});

	it("Safety block keeps the three durable rules", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Safety/);
		// OpenClaw-lifted constitution-style baseline (anti-self-preservation,
		// human-oversight priority, no-self-modification). Replaces the
		// earlier operator-protection bullets which were already covered at
		// the exec-gate layer (workdir/env refusal + decideApproval).
		assert.match(out.text, /no independent goals/i);
		assert.match(out.text, /human oversight/i);
		assert.match(out.text, /never bypass safeguards/i);
		assert.match(out.text, /Anthropic's constitution/i);
	});

	it("Brigade CLI Quick Reference lists operator-critical subcommands", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Brigade CLI Quick Reference/);
		// Trimmed to gateway lifecycle + onboard + doctor (mirror of OpenClaw
		// `system-prompt.ts:704-712`). The earlier enumeration of every
		// subcommand trained the model to suggest `brigade <foo>` in
		// conversational replies about unrelated topics — see assembler.ts
		// comment at the CLI block for details.
		assert.match(out.text, /brigade gateway/);
		assert.match(out.text, /brigade gateway status/);
		assert.match(out.text, /brigade gateway stop/);
		assert.match(out.text, /brigade onboard/);
		assert.match(out.text, /brigade doctor/);
		// And the help-fallback line that lets the model defer to the operator
		// instead of guessing at command shapes it doesn't know.
		assert.match(out.text, /brigade --help/);
	});

	it("Workspace block declares the absolute workspace dir", () => {
		const out = assembleSystemPrompt({
			runtime: { ...MOCK_RUNTIME, workspaceDir: "/home/me/.brigade/workspace" },
			personaFiles: [],
			toolDescriptions: [],
		});
		assert.match(out.text, /## Workspace/);
		assert.match(out.text, /\/home\/me\/\.brigade\/workspace/);
		assert.match(out.text, /single global workspace/);
	});

	it("everything in the canonical mirror sits ABOVE the cache boundary", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "stub" },
			],
			toolDescriptions: [],
		});
		const boundaryIdx = out.text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
		const checkpoints = [
			"## Tooling",
			"## Tool Call Style",
			"## Execution Bias",
			"## Safety",
			"## Brigade CLI Quick Reference",
			"## Workspace",
			"# Project Context",
		];
		for (const c of checkpoints) {
			const idx = out.text.indexOf(c);
			assert.ok(idx > 0 && idx < boundaryIdx, `${c} must sit above the cache boundary`);
		}
	});
});

describe("assembleSystemPrompt — Reasoning Format (OpenClaw mirror, conditional)", () => {
	it("emits <think>/<final> guidance for non-native-reasoning model with thinking ON", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "openai/gpt-4o",
			thinkingLevel: "high",
		});
		assert.match(out.text, /Reasoning format/i);
		assert.match(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance when thinkingLevel is off", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "openai/gpt-4o",
			thinkingLevel: "off",
		});
		assert.doesNotMatch(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance for Claude (native extended thinking)", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [],
			toolDescriptions: [],
			modelId: "anthropic/claude-opus-4-7",
			thinkingLevel: "high",
		});
		assert.doesNotMatch(out.text, /<think>/);
	});

	it("does NOT emit <think> guidance for o1/o3 (native internal reasoning)", () => {
		for (const id of ["o1-preview", "o3-mini", "openai/o3-mini"]) {
			const out = assembleSystemPrompt({
				runtime: MOCK_RUNTIME,
				personaFiles: [],
				toolDescriptions: [],
				modelId: id,
				thinkingLevel: "high",
			});
			assert.doesNotMatch(out.text, /<think>/, `${id} should not get <think> guidance`);
		}
	});
});

describe("assembleSystemPrompt — persona file canonical sort", () => {
	it("orders persona files: AGENTS, SOUL, IDENTITY, USER, TOOLS, BOOTSTRAP, MEMORY", () => {
		const out = assembleSystemPrompt({
			runtime: MOCK_RUNTIME,
			personaFiles: [
				{ name: "MEMORY.md", path: "/x/MEMORY.md", content: "m" },
				{ name: "USER.md", path: "/x/USER.md", content: "u" },
				{ name: "AGENTS.md", path: "/x/AGENTS.md", content: "a" },
				{ name: "BOOTSTRAP.md", path: "/x/BOOTSTRAP.md", content: "b" },
				{ name: "SOUL.md", path: "/x/SOUL.md", content: "s" },
				{ name: "TOOLS.md", path: "/x/TOOLS.md", content: "t" },
				{ name: "IDENTITY.md", path: "/x/IDENTITY.md", content: "i" },
			],
			toolDescriptions: [],
		});
		const order = ["## AGENTS", "## SOUL", "## IDENTITY", "## USER", "## TOOLS", "## BOOTSTRAP", "## MEMORY"];
		let lastIdx = -1;
		for (const h of order) {
			const idx = out.text.indexOf(h);
			assert.ok(idx > lastIdx, `${h} should appear in canonical order`);
			lastIdx = idx;
		}
	});
});

describe("assembleSystemPrompt — capabilities flag is accepted but ignored", () => {
	// The `capabilities` arg still threads through (so callers don't break);
	// the corresponding guidance blocks just aren't injected today. Memory /
	// Skills / Sub-agents land alongside Primitives #4-6.
	it("does NOT inject Memory/Skills/Sub-agents blocks even when capabilities=true", () => {
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
