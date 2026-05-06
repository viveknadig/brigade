import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import {
  DEFAULT_AGENT_ID,
  ensureDir,
  resolveAllPaths,
  resolveLogsDir,
  resolveTasksDir,
} from "../../config/paths.js";
import { writeConfigSafe, readConfigOrInit } from "../../config/io.js";
import { initAuthProfiles } from "../../auth/profiles.js";
import { bootstrapWorkspace } from "../../workspace/bootstrap.js";
import { ensureDeviceIdentity } from "../../identity/device.js";

interface OnboardOptions {
  agentId: string;
  workspace?: string;
  installDaemon?: boolean;
}

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Set up ~/.brigade/ — workspace, auth scaffolding, default config")
    .option("--agent-id <id>", "agent id to provision", DEFAULT_AGENT_ID)
    .option("--workspace <dir>", "override workspace directory")
    .option("--install-daemon", "also install the gateway daemon")
    .action(async (raw: OnboardOptions) => {
      await runOnboard(raw);
    });
}

export async function runOnboard(opts: OnboardOptions): Promise<void> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const paths = resolveAllPaths(agentId, opts.workspace);

  // Eagerly create only the dirs the runtime actively uses. Other dirs
  // (cache/, oauth/, credentials/, completions/) are created lazily by
  // their own subsystems on first write — that matches the reference's
  // pattern and avoids leaving empty-looking dirs behind that suggest
  // brigade is provisioning more than it actually is.
  ensureDir(paths.stateDir);
  ensureDir(paths.agentDir);
  ensureDir(paths.authDir);
  ensureDir(paths.sessionsDir);
  ensureDir(resolveTasksDir());
  ensureDir(resolveLogsDir());

  // brigade.json — create only if missing so we never clobber user config.
  const config = readConfigOrInit();
  if (!config.agents) config.agents = {};
  if (!config.agents[agentId]) {
    config.agents[agentId] = {
      workspace: opts.workspace ?? null,
      defaultRoute: null,
    };
    writeConfigSafe(config);
  }

  // auth-profiles.json — empty scaffold at mode 0600, never overwrite.
  initAuthProfiles(agentId);

  // Empty session-key index so the runtime has something to read on first turn.
  if (!fs.existsSync(paths.sessionStorePath)) {
    fs.writeFileSync(
      paths.sessionStorePath,
      JSON.stringify({ version: 1, sessions: {} }, null, 2),
      "utf8",
    );
  }

  // 7 workspace files (AGENTS, BOOTSTRAP, IDENTITY, SOUL, TOOLS, HEARTBEAT, USER).
  // Content is loaded from templates/workspace/ on disk via the loader.
  // bootstrapWorkspace is also responsible for git-init on truly fresh
  // workspaces and for honouring the brand-new-workspace probe so
  // re-onboard against a customised workspace doesn't resurrect BOOTSTRAP.md.
  const ws = await bootstrapWorkspace(paths.workspaceDir);

  // Ed25519 device identity. Written once on first onboard; subsequent
  // calls are a no-op. Required for any future device-pairing primitive.
  const identity = await ensureDeviceIdentity();

  printOnboardSummary({
    agentId,
    paths,
    createdWorkspaceFiles: ws.created.length,
    missingTemplates: ws.missingTemplates,
    workspaceGitInitialised: ws.gitInitialised,
    deviceIdCreated: identity.created,
    deviceId: identity.identity.deviceId,
  });

  if (opts.installDaemon) {
    console.log("");
    console.log("[note] --install-daemon is not yet implemented in this scaffold.");
    console.log("       Once the gateway module lands, this flag will install");
    console.log("       the per-OS service: launchd / systemd / Task Scheduler.");
  }
}

function printOnboardSummary(args: {
  agentId: string;
  paths: ReturnType<typeof resolveAllPaths>;
  createdWorkspaceFiles: number;
  missingTemplates: readonly string[];
  workspaceGitInitialised: boolean;
  deviceIdCreated: boolean;
  deviceId: string;
}): void {
  const { agentId, paths, createdWorkspaceFiles, missingTemplates } = args;
  console.log("Brigade onboarded.");
  console.log("");
  console.log(`  Agent id          ${agentId}`);
  console.log(`  State dir         ${paths.stateDir}`);
  console.log(`  Config            ${paths.configPath}`);
  console.log(`  Auth dir          ${paths.authDir}`);
  console.log(`  Auth profiles     ${path.basename(paths.authProfilesPath)} (mode 0600)`);
  console.log(`  Sessions          ${paths.sessionsDir}`);
  console.log(`  Workspace         ${paths.workspaceDir}`);
  console.log(`  Workspace files   ${createdWorkspaceFiles} created`);
  console.log(
    `  Workspace git     ${args.workspaceGitInitialised ? "initialised" : "skipped (existing or git unavailable)"}`,
  );
  console.log(
    `  Device identity   ${args.deviceIdCreated ? "generated" : "existing"} (${args.deviceId.slice(0, 8)}…)`,
  );
  console.log(`  Tasks db          ${paths.tasksDbPath} (lazy)`);
  if (missingTemplates.length > 0) {
    console.log("");
    console.log(
      `  [warn] templates missing for: ${missingTemplates.join(", ")}.`,
    );
    console.log(
      "         Drop the corresponding markdown into templates/workspace/ and re-run onboard.",
    );
  }
  console.log("");
  console.log("Next: `brigade agent --message \"hello\"` to drive a turn,");
  console.log("      or `brigade tui` for the interactive shell.");
}
