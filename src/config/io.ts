import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import JSON5 from "json5";

import {
  ensureDir,
  resolveConfigAuditLogPath,
  resolveConfigPath,
  resolveLogsDir,
} from "./paths.js";

// brigade.json shape — intentionally loose at this stage so individual
// subsystems can extend it without churning a central schema. Tightening
// happens once the runtime modules stabilise.
export interface BrigadeConfig {
  version: number;
  agents?: Record<string, AgentConfig>;
  defaults?: {
    agentId?: string;
    // When set, replaces the assembled system prompt entirely for every
    // agent that doesn't define its own override. Useful for testing.
    systemPromptOverride?: string;
  };
  [key: string]: unknown;
}

export interface AgentConfig {
  workspace?: string | null;
  defaultRoute?: string | null;
  [key: string]: unknown;
}

const CURRENT_VERSION = 1;
// Keeps `.bak` + `.bak.1..4` — five forensic snapshots so a bad write can be
// recovered even after several subsequent saves.
const BACKUP_COUNT = 5;

const SECRET_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

export function readConfigOrInit(): BrigadeConfig {
  const cfgPath = resolveConfigPath();
  if (!fs.existsSync(cfgPath)) {
    return { version: CURRENT_VERSION, agents: {}, defaults: {} };
  }
  const raw = fs.readFileSync(cfgPath, "utf8");
  const parsed = JSON5.parse(raw) as BrigadeConfig;

  // On read, resolve ${VAR} references against process.env. The original
  // string form is tracked separately so writeConfigSafe can restore it.
  resolveSecretsInPlace(parsed, /* track */ true);
  return parsed;
}

export function writeConfigSafe(config: BrigadeConfig): void {
  const cfgPath = resolveConfigPath();
  ensureDir(path.dirname(cfgPath));

  // Restore ${VAR} references from the side-table so resolved secrets never
  // hit disk. Any value that doesn't have a tracked reference is written
  // through verbatim — that's fine, only sensitive fields use ${VAR} syntax.
  const restored = restoreSecrets(config);

  rotateBackups(cfgPath);

  const serialized = JSON5.stringify(restored, null, 2);
  if (serialized === undefined) {
    // JSON5.stringify returns undefined for unserialisable values (BigInt,
    // Function, Symbol). Failing loud here prevents the alternative —
    // silently writing an empty file and bricking the next read.
    throw new Error(
      "brigade.json contains an unserialisable value (BigInt, Function, or Symbol).",
    );
  }
  const tmp = `${cfgPath}.tmp`;
  fs.writeFileSync(tmp, serialized, "utf8");
  fs.renameSync(tmp, cfgPath);

  appendConfigAudit(cfgPath, serialized);
}

// Rotation: drop the oldest snapshot, shift each .bak.N down one slot,
// rename the previous head to .bak.1, then copy the live file to .bak.
function rotateBackups(cfgPath: string): void {
  if (!fs.existsSync(cfgPath)) return;

  const oldest = `${cfgPath}.bak.${BACKUP_COUNT - 1}`;
  if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });

  for (let i = BACKUP_COUNT - 2; i >= 1; i--) {
    const from = `${cfgPath}.bak.${i}`;
    const to = `${cfgPath}.bak.${i + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  const head = `${cfgPath}.bak`;
  if (fs.existsSync(head)) fs.renameSync(head, `${cfgPath}.bak.1`);

  fs.copyFileSync(cfgPath, head);
  hardenBackupPermissions(head);
}

function hardenBackupPermissions(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort — some filesystems (FAT32, network mounts) reject chmod.
  }
}

function appendConfigAudit(cfgPath: string, contents: string): void {
  try {
    ensureDir(resolveLogsDir());
    const sha = createHash("sha256").update(contents).digest("hex");
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      path: cfgPath,
      bytes: Buffer.byteLength(contents, "utf8"),
      sha256: sha,
    });
    fs.appendFileSync(resolveConfigAuditLogPath(), `${record}\n`, "utf8");
  } catch {
    // Audit logging is best-effort; never block a successful config write.
  }
}

// Side-table: maps the JSON pointer-ish path of a value to its original
// ${VAR} string. The cleanest implementation will move this into a class,
// but a module-level WeakMap keyed by the parsed object is enough for now.
const secretRefs = new WeakMap<object, Map<string, string>>();

function resolveSecretsInPlace(obj: unknown, track: boolean, base?: object): void {
  if (obj === null || typeof obj !== "object") return;
  const root = base ?? (obj as object);
  if (track && !secretRefs.has(root)) secretRefs.set(root, new Map());
  const refs = secretRefs.get(root);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === "string") {
        const m = SECRET_REF_PATTERN.exec(v);
        if (m && m[1]) {
          if (track && refs) refs.set(jsonPointer(obj, i, root), v);
          obj[i] = process.env[m[1]] ?? "";
        }
      } else {
        resolveSecretsInPlace(v, track, root);
      }
    }
    return;
  }

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") {
      const m = SECRET_REF_PATTERN.exec(v);
      if (m && m[1]) {
        if (track && refs) refs.set(jsonPointer(obj as object, key, root), v);
        (obj as Record<string, unknown>)[key] = process.env[m[1]] ?? "";
      }
    } else if (v !== null && typeof v === "object") {
      resolveSecretsInPlace(v, track, root);
    }
  }
}

function restoreSecrets(config: BrigadeConfig): BrigadeConfig {
  const refs = secretRefs.get(config);
  if (!refs || refs.size === 0) return config;

  const clone = JSON.parse(JSON.stringify(config)) as BrigadeConfig;
  for (const [pointer, original] of refs) {
    setByPointer(clone, pointer, original);
  }
  return clone;
}

// Minimal JSON-pointer-like helpers — full RFC 6901 isn't needed here since
// we only encode our own paths. Keys are joined with "/" and may include
// numeric array indices.
function jsonPointer(parent: object, key: string | number, root: object): string {
  const path = pathOf(root, parent);
  return [...path, String(key)].join("/");
}

function pathOf(root: object, target: object): string[] {
  if (root === target) return [];
  const seen = new WeakSet<object>();
  const stack: { node: object; path: string[] }[] = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === target) return path;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") {
        stack.push({ node: v as object, path: [...path, k] });
      }
    }
  }
  return [];
}

function setByPointer(root: BrigadeConfig, pointer: string, value: string): void {
  const parts = pointer.split("/");
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (k === undefined) return;
    if (cur[k] === undefined || cur[k] === null) return;
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return;
  cur[last] = value;
}
