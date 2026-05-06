import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// All filesystem paths the brigade runtime touches resolve through this module.
// Override via BRIGADE_STATE_DIR / BRIGADE_CONFIG_PATH so tests + alt installs
// can run isolated from ~/.brigade.

// Canonical default agent id. Session-key resolution hardcodes this same
// value; changing it requires a state migration so existing transcripts
// remain reachable.
export const DEFAULT_AGENT_ID = "main";

export function resolveStateDir(): string {
  const override = process.env.BRIGADE_STATE_DIR?.trim();
  if (override && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".brigade");
}

export function resolveConfigPath(): string {
  const override = process.env.BRIGADE_CONFIG_PATH?.trim();
  if (override && override.length > 0) return path.resolve(override);
  return path.join(resolveStateDir(), "brigade.json");
}

export function resolveAgentDir(agentId: string): string {
  return path.join(resolveStateDir(), "agents", agentId);
}

// Auth lives at <agentDir>/agent/ — NOT <agentDir>/.brigade/.
// auth-profiles.json, auth-state.json, models.json all live here.
export function resolveAuthDir(agentId: string): string {
  return path.join(resolveAgentDir(agentId), "agent");
}

export function resolveAuthProfilesPath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "auth-profiles.json");
}

export function resolveAuthStatePath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "auth-state.json");
}

export function resolveModelsPath(agentId: string): string {
  return path.join(resolveAuthDir(agentId), "models.json");
}

// Sessions are Pi SDK JSONL transcripts: one file per session.
export function resolveSessionsDir(agentId: string): string {
  return path.join(resolveAgentDir(agentId), "sessions");
}

export function resolveSessionStorePath(agentId: string): string {
  return path.join(resolveSessionsDir(agentId), "sessions.json");
}

export function resolveSessionTranscriptPath(agentId: string, sessionId: string): string {
  return path.join(resolveSessionsDir(agentId), `${sessionId}.jsonl`);
}

// Workspace is configurable per-agent in brigade.json. Default lives next to
// the auth dir so the whole agent state is co-located.
export function resolveAgentWorkspaceDir(agentId: string, override?: string): string {
  if (override && override.length > 0) return path.resolve(override);
  return path.join(resolveAgentDir(agentId), "workspace");
}

export function resolveTasksDir(): string {
  return path.join(resolveStateDir(), "tasks");
}

export function resolveTasksDbPath(): string {
  return path.join(resolveTasksDir(), "runs.sqlite");
}

export function resolveLogsDir(): string {
  return path.join(resolveStateDir(), "logs");
}

export function resolveIdentityDir(): string {
  return path.join(resolveStateDir(), "identity");
}

export function resolveCompletionsDir(): string {
  return path.join(resolveStateDir(), "completions");
}

export function resolveOauthDir(): string {
  return path.join(resolveStateDir(), "oauth");
}

export function resolveCredentialsDir(): string {
  return path.join(resolveStateDir(), "credentials");
}

export function resolveCacheDir(): string {
  return path.join(resolveStateDir(), "cache");
}

export function resolveConfigAuditLogPath(): string {
  return path.join(resolveLogsDir(), "config-audit.jsonl");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export interface BrigadePaths {
  stateDir: string;
  configPath: string;
  agentDir: string;
  authDir: string;
  authProfilesPath: string;
  sessionsDir: string;
  sessionStorePath: string;
  workspaceDir: string;
  tasksDbPath: string;
  logsDir: string;
}

export function resolveAllPaths(agentId: string, workspaceOverride?: string): BrigadePaths {
  return {
    stateDir: resolveStateDir(),
    configPath: resolveConfigPath(),
    agentDir: resolveAgentDir(agentId),
    authDir: resolveAuthDir(agentId),
    authProfilesPath: resolveAuthProfilesPath(agentId),
    sessionsDir: resolveSessionsDir(agentId),
    sessionStorePath: resolveSessionStorePath(agentId),
    workspaceDir: resolveAgentWorkspaceDir(agentId, workspaceOverride),
    tasksDbPath: resolveTasksDbPath(),
    logsDir: resolveLogsDir(),
  };
}
