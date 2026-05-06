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

  // Ctrl-C / kill propagates as an AbortSignal into the agent loop. The
  // first SIGINT requests a graceful abort (drains in-flight retries);
  // a second SIGINT within the same process tears the run down hard
  // by exiting with 130 (the conventional shell signal-code).
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      console.error("\n[brigade] interrupt received — aborting run gracefully (Ctrl-C again to force exit)");
      abortController.abort(new Error("Interrupted by user"));
      return;
    }
    console.error("\n[brigade] forced exit on second interrupt");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  let result: Awaited<ReturnType<typeof runSingleTurn>>;
  try {
    // No try/catch around runSingleTurn for the *non-abort* path — runtime
    // errors propagate to run-main's mapErrorToExitCode, which prefixes
    // with `brigade:` and returns the right exit code for entry.ts to
    // surface. The try/finally exists only to clean up the signal
    // listeners regardless of outcome.
    result = await runSingleTurn({
      agentId,
      provider,
      modelId,
      message: opts.message,
      sessionKey,
      workspaceDir: opts.workspace,
      thinkingLevel: opts.thinkingLevel ?? "off",
      signal: abortController.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }

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
