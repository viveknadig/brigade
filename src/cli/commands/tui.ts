import { Command } from "commander";

import { DEFAULT_AGENT_ID, resolveAllPaths } from "../../config/paths.js";

interface TuiOptions {
  agentId: string;
}

export function registerTuiCommand(program: Command): void {
  program
    .command("tui")
    .description("Launch the interactive terminal UI")
    .option("--agent-id <id>", "agent id", DEFAULT_AGENT_ID)
    .action(async (raw: TuiOptions) => {
      await runTui(raw);
    });
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const paths = resolveAllPaths(agentId);

  console.log(`Brigade TUI (scaffold) — agent=${agentId}`);
  console.log(`State dir: ${paths.stateDir}`);
  console.log("");
  console.log("The interactive shell isn't implemented yet. Once src/ui/tui");
  console.log("lands, this command will spawn the readline-based REPL with");
  console.log("streamed Pi SDK responses.");
  console.log("");
  console.log("For now use `brigade agent --message \"…\"` to drive single turns.");
}
