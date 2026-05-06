import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolves the /single line of dynamic runtime context that goes into the
// system prompt's `## Runtime` block. Kept pure-ish so it can be exercised
// by tests with injected env/cwd.

export interface RuntimeParams {
  agentId: string;
  workspaceDir: string;
  cwd: string;
  hostName: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  shell: string | undefined;
  modelLabel: string;
  channelLabel: string;
  thinkingLevel: string;
  timezone: string;
  nowIso: string;
  repoRoot: string | undefined;
}

export interface ResolveRuntimeArgs {
  agentId: string;
  workspaceDir: string;
  cwd: string;
  modelLabel: string;
  channelLabel?: string;
  thinkingLevel?: string;
}

export function resolveRuntimeParams(args: ResolveRuntimeArgs): RuntimeParams {
  return {
    agentId: args.agentId,
    workspaceDir: args.workspaceDir,
    cwd: args.cwd,
    hostName: safeHostName(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    shell: process.env.SHELL ?? process.env.ComSpec,
    modelLabel: args.modelLabel,
    channelLabel: args.channelLabel ?? "cli",
    thinkingLevel: args.thinkingLevel ?? "off",
    timezone: resolveTimezone(),
    nowIso: new Date().toISOString(),
    repoRoot: findGitRoot(args.workspaceDir) ?? findGitRoot(args.cwd),
  };
}

// Renders to a single one-liner for the prompt's `## Runtime` block.
export function formatRuntimeLine(p: RuntimeParams): string {
  const parts = [
    `agent=${p.agentId}`,
    `host=${p.hostName}`,
    `os=${p.platform}/${p.arch}`,
    `node=${p.nodeVersion}`,
    `shell=${p.shell ?? "?"}`,
    `tz=${p.timezone}`,
    `now=${p.nowIso}`,
    `model=${p.modelLabel}`,
    `channel=${p.channelLabel}`,
    `thinking=${p.thinkingLevel}`,
  ];
  if (p.repoRoot) parts.push(`repo=${p.repoRoot}`);
  return parts.join(" ");
}

// Walk upwards from `start` looking for a .git/ directory. Bounded by
// filesystem root and a 12-level cap so a misconfigured cwd can't burn cycles.
export function findGitRoot(start: string): string | undefined {
  let cur = path.resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function safeHostName(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
}
