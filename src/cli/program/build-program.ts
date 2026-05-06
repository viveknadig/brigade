import { Command } from "commander";

import { VERSION } from "../../version.js";
import { registerOnboardCommand } from "../commands/onboard.js";
import { registerAgentCommand } from "../commands/agent.js";
import { registerTuiCommand } from "../commands/tui.js";

// Builds the Commander program with every subcommand registered. Kept tiny
// on purpose — actual command logic lives under src/cli/commands/.

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("brigade")
    .description("Brigade — AI crew framework")
    .version(VERSION, "-v, --version", "show brigade version");

  // exitOverride lets runMain decide how to surface help/no-args, instead of
  // Commander killing the process directly with exit(1).
  program.exitOverride();

  registerOnboardCommand(program);
  registerAgentCommand(program);
  registerTuiCommand(program);

  return program;
}
