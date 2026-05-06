import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ensureDir,
  resolveSessionStorePath,
  resolveSessionTranscriptPath,
  resolveSessionsDir,
} from "../config/paths.js";

// sessions.json maps a session-key (e.g. "agent:default:main") to the
// concrete sessionId whose JSONL transcript holds the conversation.
//
// One session-key → one sessionId → one <sessionId>.jsonl file. The Pi SDK
// owns the JSONL contents; we own this index.

export interface SessionEntry {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  // Optional per-session overrides — provider/model/auth profile/think level.
  // Kept loose; Pi consumes whatever it understands and ignores the rest.
  provider?: string;
  modelId?: string;
  authProfile?: string;
  thinkingLevel?: string;
  [key: string]: unknown;
}

export interface SessionStoreFile {
  version: number;
  sessions: Record<string, SessionEntry>;
}

const CURRENT_VERSION = 1;

export function readSessionStore(agentId: string): SessionStoreFile {
  const storePath = resolveSessionStorePath(agentId);
  if (!fs.existsSync(storePath)) {
    return { version: CURRENT_VERSION, sessions: {} };
  }
  const raw = fs.readFileSync(storePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as SessionStoreFile;
    if (!parsed.sessions) parsed.sessions = {};
    return parsed;
  } catch {
    return { version: CURRENT_VERSION, sessions: {} };
  }
}

export function writeSessionStore(agentId: string, file: SessionStoreFile): void {
  const storePath = resolveSessionStorePath(agentId);
  ensureDir(path.dirname(storePath));
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
  fs.renameSync(tmp, storePath);
}

export interface ResolvedSession {
  sessionKey: string;
  sessionId: string;
  transcriptPath: string;
  isNew: boolean;
  entry: SessionEntry;
}

// Resolve the sessionId for a given session-key. Creates a new entry the
// first time a key is seen; touches lastUsedAt every time.
export function resolveOrCreateSession(args: {
  agentId: string;
  sessionKey: string;
  overrides?: Partial<SessionEntry>;
}): ResolvedSession {
  const { agentId, sessionKey } = args;
  const store = readSessionStore(agentId);
  const now = new Date().toISOString();
  let entry = store.sessions[sessionKey];
  let isNew = false;

  if (!entry) {
    entry = {
      sessionId: randomUUID(),
      createdAt: now,
      lastUsedAt: now,
      ...(args.overrides ?? {}),
    };
    store.sessions[sessionKey] = entry;
    isNew = true;
  } else {
    entry.lastUsedAt = now;
    if (args.overrides) Object.assign(entry, args.overrides);
  }

  writeSessionStore(agentId, store);

  // Make sure the sessions/ directory exists; the JSONL itself is created
  // lazily by Pi's SessionManager on first write.
  ensureDir(resolveSessionsDir(agentId));

  return {
    sessionKey,
    sessionId: entry.sessionId,
    transcriptPath: resolveSessionTranscriptPath(agentId, entry.sessionId),
    isNew,
    entry,
  };
}

export function defaultSessionKey(agentId: string): string {
  return `agent:${agentId}:main`;
}
