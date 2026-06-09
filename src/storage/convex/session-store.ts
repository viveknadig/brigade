// src/storage/convex/session-store.ts
import { randomUUID } from "node:crypto";

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { getReactiveConvexClient } from "./client.js";

import type {
	ResolvedSession,
	SessionEntry,
	SessionStore,
	SubagentSessionMetadata,
	Unsub,
} from "../store.js";

interface Deps { client: ConvexHttpClient }

export class ConvexSessionStore implements SessionStore {
	constructor(private readonly deps: Deps) {}

	async resolveOrCreate(args: {
		agentId: string;
		sessionKey: string;
		overrides?: Partial<SessionEntry>;
		freshnessMs?: number;
	}): Promise<ResolvedSession> {
		const existing = (await this.deps.client.query(api.sessions.getEntry, {
			agentId: args.agentId,
			sessionKey: args.sessionKey,
		})) as Record<string, unknown> | null;

		const now = Date.now();
		if (existing && args.freshnessMs && args.freshnessMs > 0) {
			const lastUsedAt = (existing.lastUsedAt as number | undefined) ?? 0;
			if (now - lastUsedAt > args.freshnessMs) {
				const sessionId = randomUUID();
				const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
					agentId: args.agentId,
					sessionKey: args.sessionKey,
					sessionId,
					createdAt: now,
					lastUsedAt: now,
					...((args.overrides as Record<string, unknown> | undefined) ?? {}),
				})) as Record<string, unknown>;
				return { entry: row as unknown as SessionEntry, created: true };
			}
		}
		if (existing) {
			const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
				agentId: args.agentId,
				sessionKey: args.sessionKey,
				sessionId: existing.sessionId as string,
				createdAt: existing.createdAt as number,
				lastUsedAt: now,
				...((args.overrides as Record<string, unknown> | undefined) ?? {}),
			})) as Record<string, unknown>;
			return { entry: row as unknown as SessionEntry, created: false };
		}
		const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
			agentId: args.agentId,
			sessionKey: args.sessionKey,
			sessionId: randomUUID(),
			createdAt: now,
			lastUsedAt: now,
			...((args.overrides as Record<string, unknown> | undefined) ?? {}),
		})) as Record<string, unknown>;
		return { entry: row as unknown as SessionEntry, created: true };
	}

	async getEntry(agentId: string, sessionKey: string): Promise<SessionEntry | undefined> {
		const row = (await this.deps.client.query(api.sessions.getEntry, {
			agentId,
			sessionKey,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as SessionEntry) : undefined;
	}

	async upsertEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry> {
		const existing = await this.getEntry(agentId, sessionKey);
		const row = (await this.deps.client.mutation(api.sessions.upsertEntry, {
			agentId,
			sessionKey,
			sessionId: (existing as { sessionId?: string })?.sessionId ?? randomUUID(),
			...((patch as Record<string, unknown> | undefined) ?? {}),
		})) as Record<string, unknown>;
		return row as unknown as SessionEntry;
	}

	async updateEntry(
		agentId: string,
		sessionKey: string,
		patch: Partial<SessionEntry>,
	): Promise<SessionEntry | null> {
		const existing = await this.getEntry(agentId, sessionKey);
		if (!existing) return null;
		return this.upsertEntry(agentId, sessionKey, patch);
	}

	async deleteEntry(agentId: string, sessionKey: string): Promise<boolean> {
		return (await this.deps.client.mutation(api.sessions.deleteEntry, {
			agentId,
			sessionKey,
		})) as boolean;
	}

	async listEntries(
		agentId: string,
		filter?: { isolatedCronRunOlderThanMs?: number; subagentOnly?: boolean },
	): Promise<Array<{ sessionKey: string; entry: SessionEntry }>> {
		const rows = (await this.deps.client.query(api.sessions.listEntries, {
			agentId,
			...(filter?.subagentOnly !== undefined ? { subagentOnly: filter.subagentOnly } : {}),
		})) as Array<Record<string, unknown>>;
		const now = Date.now();
		const cutoff =
			filter?.isolatedCronRunOlderThanMs !== undefined
				? now - filter.isolatedCronRunOlderThanMs
				: undefined;
		return rows
			.filter((r) => {
				if (cutoff === undefined) return true;
				const sk = r.sessionKey as string;
				if (!sk.startsWith("isolated:cron:")) return false;
				const last = (r.lastUsedAt as number | undefined) ?? 0;
				return last < cutoff;
			})
			.map((r) => ({ sessionKey: r.sessionKey as string, entry: r as unknown as SessionEntry }));
	}

	async readSubagentMetadata(
		agentId: string,
		sessionKey: string,
	): Promise<SubagentSessionMetadata | undefined> {
		const entry = await this.getEntry(agentId, sessionKey);
		const subagent = (entry as { subagent?: unknown } | undefined)?.subagent;
		return subagent ? (subagent as unknown as SubagentSessionMetadata) : undefined;
	}

	async listSubagentEntries(
		agentId: string,
	): Promise<
		Array<{ sessionKey: string; entry: SessionEntry; subagent: SubagentSessionMetadata }>
	> {
		const rows = (await this.deps.client.query(api.sessions.listEntries, {
			agentId,
			subagentOnly: true,
		})) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			sessionKey: r.sessionKey as string,
			entry: r as unknown as SessionEntry,
			subagent: (r.subagent ?? {}) as unknown as SubagentSessionMetadata,
		}));
	}

	subscribe(agentId: string, cb: (entries: SessionEntry[]) => void): Unsub {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.sessions.listEntries,
			{ agentId },
			(rows) => {
				try {
					cb(rows as unknown as SessionEntry[]);
				} catch {
					// Subscriber threw — stay alive.
				}
			},
		);
		return () => {
			try {
				unsub();
			} catch {
				// Idempotent.
			}
		};
	}
}
