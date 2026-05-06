import { Command } from "commander";

import { runSingleTurn } from "../../agents/agent-loop.js";
import { readConfigOrInit } from "../../config/io.js";
import { DEFAULT_AGENT_ID, resolveAllPaths } from "../../config/paths.js";
import { defaultSessionKey } from "../../sessions/session-store.js";

interface AgentOptions {
  agentId: string;
  message?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspace?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

export function registerAgentCommand(program: Command): void {
  program
    .command("agent")
    .description("Drive a single turn through the agent pipeline")
    .option("--agent-id <id>", "agent id", DEFAULT_AGENT_ID)
    .option("-m, --message <text>", "user message to send")
    .option("--session-key <key>", "session key (default: agent:<id>:main)")
    .option("--provider <name>", "provider id (e.g. anthropic, openrouter, ollama)")
    .option("--model <id>", "model id (e.g. claude-sonnet-4-6)")
    .option("--workspace <dir>", "override workspace directory")
    .option(
      "--thinking-level <level>",
      "off | low | medium | high (model-dependent)",
      "off",
    )
    .action(async (raw: AgentOptions) => {
      await runAgentTurn(raw);
    });
}

export async function runAgentTurn(opts: AgentOptions): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const sessionKey = opts.sessionKey ?? defaultSessionKey(agentId);
  const paths = resolveAllPaths(agentId, opts.workspace);

  // Validation errors throw rather than `process.exitCode = 1; return`.
  // entry.ts unconditionally calls process.exit(returnedCode) and would
  // mask exitCode=1 set on the global object — throwing routes through
  // run-main's mapErrorToExitCode and produces the right non-zero exit.
  if (!opts.message || opts.message.length === 0) {
    throw new Error("agent: --message is required.");
  }

  // Provider/model: CLI flags first, then per-agent defaults from brigade.json.
  const cfg = readConfigOrInit();
  const agentCfg = cfg.agents?.[agentId] as
    | { defaultProvider?: string; defaultModel?: string }
    | undefined;
  const provider = opts.provider ?? agentCfg?.defaultProvider;
  const modelId = opts.model ?? agentCfg?.defaultModel;

  if (!provider || !modelId) {
    throw new Error(
      "agent: --provider and --model are required " +
        "(or set defaultProvider/defaultModel in brigade.json under agents.<id>).",
    );
  }

  console.error(
    `[brigade] agent=${agentId} provider=${provider} model=${modelId} ` +
      `sessionKey=${sessionKey} state=${paths.stateDir}`,
  );

  // No try/catch — let runtime errors propagate to run-main's
  // mapErrorToExitCode, which prefixes with `brigade:` and returns the
  // right exit code for entry.ts to surface.
  const result = await runSingleTurn({
    agentId,
    provider,
    modelId,
    message: opts.message,
    sessionKey,
    workspaceDir: opts.workspace,
    thinkingLevel: opts.thinkingLevel ?? "off",
  });

  if (result.isNewSession) {
    console.error(`[brigade] new session: ${result.sessionId}`);
  } else {
    console.error(`[brigade] continuing session: ${result.sessionId}`);
  }

  // Reply goes to stdout so it composes cleanly with shell pipes;
  // diagnostics go to stderr above.
  process.stdout.write(result.reply);
  if (!result.reply.endsWith("\n")) process.stdout.write("\n");
}
