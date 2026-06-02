/**
 * `sessions_spawn` agent tool (Step 20).
 *
 * Thin factory around `spawnSubagentDirect` (the spawn engine). The tool
 * declares its TypeBox-shaped schema, parses + validates args, then
 * delegates to the engine and returns a structured `jsonToolResult`.
 *
 * Pi AgentTool shape (best-effort match — Brigade pins to the version in
 * `node_modules/@mariozechner/pi-coding-agent`):
 *
 *   {
 *     name: "sessions_spawn",
 *     description: "...",
 *     parameters: TypeBox schema,
 *     execute: async (args, ctx) => ToolResultEnvelope,
 *   }
 *
 * The tool factory accepts the **per-turn opts** the gateway dispatcher
 * fills in (caller's session key, channel, agent id override, etc.) and
 * returns a Pi-compatible tool descriptor.
 */

import { spawnSubagentDirect } from "../../subagent-spawn.js";
import type {
	SpawnSubagentMode,
	SpawnSubagentSandboxMode,
} from "../../subagent-registry.types.js";
import {
	describeSessionsSpawnTool,
	jsonToolResult,
	SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
	ToolInputError,
	type ToolResultEnvelope,
} from "./shared.js";

export interface SessionsSpawnToolArgs {
	task: string;
	label?: string;
	agentId?: string;
	model?: string;
	thinking?: string;
	runTimeoutSeconds?: number;
	thread?: boolean;
	mode?: SpawnSubagentMode;
	cleanup?: "delete" | "keep";
	sandbox?: SpawnSubagentSandboxMode;
	lightContext?: boolean;
	expectsCompletionMessage?: boolean;
}

export interface SessionsSpawnToolOptions {
	agentSessionKey?: string;
	agentChannel?: string;
	agentAccountId?: string;
	agentTo?: string;
	agentThreadId?: string | number;
	requesterAgentIdOverride?: string;
	workspaceDir?: string;
	/** Caller's spawn depth — usually read from the session store. */
	callerDepth?: number;
	maxSpawnDepth?: number;
	maxChildrenPerAgent?: number;
}

export interface SessionsSpawnToolDescriptor {
	name: "sessions_spawn";
	displaySummary: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: SessionsSpawnToolArgs) => Promise<ToolResultEnvelope>;
}

/** TypeBox-shaped parameter declaration for the tool. Plain JSON-schema. */
const SESSIONS_SPAWN_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["task"],
	properties: {
		task: { type: "string", minLength: 1 },
		label: { type: "string", maxLength: 200 },
		agentId: { type: "string", minLength: 1, maxLength: 64 },
		model: { type: "string" },
		thinking: { type: "string" },
		runTimeoutSeconds: { type: "number", minimum: 0 },
		thread: { type: "boolean" },
		mode: { type: "string", enum: ["run", "session"] },
		cleanup: { type: "string", enum: ["delete", "keep"] },
		sandbox: { type: "string", enum: ["inherit", "require"] },
		lightContext: { type: "boolean" },
		expectsCompletionMessage: { type: "boolean" },
	},
	additionalProperties: false,
};

function coerceArgs(args: unknown): SessionsSpawnToolArgs {
	if (!args || typeof args !== "object") {
		throw new ToolInputError("sessions_spawn requires an object argument");
	}
	const obj = args as Record<string, unknown>;
	const task = typeof obj.task === "string" ? obj.task : "";
	if (!task.trim()) {
		throw new ToolInputError("sessions_spawn requires `task`");
	}
	const mode = obj.mode === "run" || obj.mode === "session" ? obj.mode : undefined;
	const cleanup =
		obj.cleanup === "delete" || obj.cleanup === "keep" ? obj.cleanup : undefined;
	const sandbox =
		obj.sandbox === "inherit" || obj.sandbox === "require" ? obj.sandbox : undefined;
	return {
		task,
		label: typeof obj.label === "string" ? obj.label : undefined,
		agentId: typeof obj.agentId === "string" ? obj.agentId : undefined,
		model: typeof obj.model === "string" ? obj.model : undefined,
		thinking: typeof obj.thinking === "string" ? obj.thinking : undefined,
		runTimeoutSeconds:
			typeof obj.runTimeoutSeconds === "number" ? obj.runTimeoutSeconds : undefined,
		thread: typeof obj.thread === "boolean" ? obj.thread : undefined,
		mode,
		cleanup,
		sandbox,
		lightContext: typeof obj.lightContext === "boolean" ? obj.lightContext : undefined,
		expectsCompletionMessage:
			typeof obj.expectsCompletionMessage === "boolean"
				? obj.expectsCompletionMessage
				: undefined,
	};
}

export function createSessionsSpawnTool(
	opts: SessionsSpawnToolOptions = {},
): SessionsSpawnToolDescriptor {
	return {
		name: "sessions_spawn",
		displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
		description: describeSessionsSpawnTool(),
		parameters: SESSIONS_SPAWN_SCHEMA,
		execute: async (args) => {
			const parsed = coerceArgs(args);
			const result = await spawnSubagentDirect(parsed, {
				agentSessionKey: opts.agentSessionKey,
				agentChannel: opts.agentChannel,
				agentAccountId: opts.agentAccountId,
				agentTo: opts.agentTo,
				agentThreadId: opts.agentThreadId,
				requesterAgentIdOverride: opts.requesterAgentIdOverride,
				workspaceDir: opts.workspaceDir,
				callerDepth: opts.callerDepth,
				maxSpawnDepth: opts.maxSpawnDepth,
				maxChildrenPerAgent: opts.maxChildrenPerAgent,
			});
			return jsonToolResult(result);
		},
	};
}
