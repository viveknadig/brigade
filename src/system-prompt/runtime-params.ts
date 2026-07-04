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
  /** Operator override (BRIGADE_HOST_ENV) for the DISPLAYED host tag in the
   *  runtime line — e.g. "windows" or "prod-container". Display-only: the
   *  `platform` field above stays the real `process.platform`, so behavioural
   *  branching (e.g. the Windows shell-hygiene guidance) is unaffected. */
  hostEnvLabel?: string;
  nodeVersion: string;
  shell: string | undefined;
  modelLabel: string;
  channelLabel: string;
  thinkingLevel: string;
  timezone: string;
  /** UTC ISO timestamp (machine-readable, kept for back-compat). */
  nowIso: string;
  /** Human-readable wall-clock time in the operator's local timezone
   *  (e.g. "Tue 2026-06-03 15:46"). The model reads this directly so it
   *  never has to convert UTC to local in its head. */
  nowLocal: string;
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
  const tz = resolveTimezone();
  const now = new Date();
  return {
    agentId: args.agentId,
    workspaceDir: args.workspaceDir,
    cwd: args.cwd,
    hostName: safeHostName(),
    platform: process.platform,
    arch: process.arch,
    hostEnvLabel: process.env.BRIGADE_HOST_ENV?.trim() || undefined,
    nodeVersion: process.versions.node,
    shell: process.env.SHELL ?? process.env.ComSpec,
    modelLabel: args.modelLabel,
    channelLabel: args.channelLabel ?? "cli",
    thinkingLevel: args.thinkingLevel ?? "off",
    timezone: tz,
    nowIso: now.toISOString(),
    nowLocal: formatLocalNow(now, tz),
    repoRoot: findGitRoot(args.workspaceDir) ?? findGitRoot(args.cwd),
  };
}

// Renders to a single one-liner for the prompt's `## Runtime` block.
// `now=` carries the operator-local wall-clock time so the model never
// has to convert UTC to local in its head — UTC ISO is kept in parentheses
// for tools/logs that need the machine-readable form.
export function formatRuntimeLine(p: RuntimeParams): string {
  const parts = [
    `agent=${p.agentId}`,
    `host=${p.hostName}`,
    `os=${p.hostEnvLabel ?? `${p.platform}/${p.arch}`}`,
    `node=${p.nodeVersion}`,
    `shell=${p.shell ?? "?"}`,
    `tz=${p.timezone}`,
    `now=${p.nowLocal} ${p.timezone} (UTC ${p.nowIso})`,
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

// Renders a Date in the operator's local timezone as `Ddd YYYY-MM-DD HH:mm`
// (e.g. `Tue 2026-06-03 15:46`). Used by the `## Runtime` line so the model
// reads a local wall-clock time directly. Falls back to UTC ISO if the
// platform's Intl can't honour the requested tz.
export function formatLocalNow(now: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const lookup = (type: string): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    const weekday = lookup("weekday");
    const year = lookup("year");
    const month = lookup("month");
    const day = lookup("day");
    let hour = lookup("hour");
    const minute = lookup("minute");
    // Intl en-GB sometimes returns "24" for midnight — normalise to "00".
    if (hour === "24") hour = "00";
    return `${weekday} ${year}-${month}-${day} ${hour}:${minute}`;
  } catch {
    return now.toISOString();
  }
}

function safeHostName(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
}
