// src/storage/convex/log-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	ConfigAuditInput,
	ConfigAuditRecord,
	ConfigHealthRecord,
	LastErrorSnapshot,
	LogFilter,
	LogStore,
	SessionEventRecord,
	SubsystemLogFilter,
	SubsystemLogRecord,
	Unsub,
} from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string; instanceId: string }

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

export class ConvexLogStore implements LogStore {
	constructor(private readonly deps: Deps) {}

	async appendSessionEvent(record: SessionEventRecord): Promise<void> {
		const r = record as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.logs.appendSessionEvent, {
			ts: (r.ts as string) ?? new Date().toISOString(),
			day: (r.day as string) ?? todayUtc(),
			ownerId: this.deps.ownerId,
			agentId: (r.agentId as string) ?? "main",
			sessionKey: (r.sessionKey as string) ?? "main",
			type: (r.type as string) ?? "unknown",
		});
	}

	async readSessionEventTail(
		opts: { day?: string; maxBytes?: number },
	): Promise<SessionEventRecord[]> {
		const rows = (await this.deps.client.query(api.logs.readSessionEventTail, {
			ownerId: this.deps.ownerId,
			...(opts.day !== undefined ? { day: opts.day } : {}),
		})) as Array<Record<string, unknown>>;
		return rows as unknown as SessionEventRecord[];
	}

	async findLastSessionError(
		_opts?: { lookbackBytes?: number },
	): Promise<LastErrorSnapshot | undefined> {
		const row = (await this.deps.client.query(api.logs.findLastError, {
			ownerId: this.deps.ownerId,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as LastErrorSnapshot) : undefined;
	}

	async appendSubsystemRecord(record: SubsystemLogRecord): Promise<void> {
		const r = record as unknown as Record<string, unknown>;
		const level = (r.level as string) ?? "info";
		if (
			level !== "trace" && level !== "debug" && level !== "info" &&
			level !== "warn" && level !== "error" && level !== "fatal"
		) {
			throw new Error(`logs.appendSubsystemRecord: invalid level "${level}"`);
		}
		const ts = (r.time as string) ?? new Date().toISOString();
		await this.deps.client.mutation(api.logs.appendSubsystemRecord, {
			time: ts,
			day: ts.slice(0, 10),
			ownerId: this.deps.ownerId,
			level,
			subsystem: (r.subsystem as string) ?? "unknown",
			message: (r.message as string) ?? "",
			...(r.fields !== undefined ? { fields: r.fields } : {}),
		});
	}

	async readSubsystemRecords(filter: SubsystemLogFilter): Promise<SubsystemLogRecord[]> {
		const f = filter as unknown as Record<string, unknown>;
		const rows = (await this.deps.client.query(api.logs.readSubsystemRecords, {
			ownerId: this.deps.ownerId,
			...(f.day !== undefined ? { day: f.day as string } : {}),
			...(f.level !== undefined ? { level: f.level as never } : {}),
			...(f.subsystem !== undefined ? { subsystem: f.subsystem as string } : {}),
			...(f.limit !== undefined ? { limit: f.limit as number } : {}),
		})) as Array<Record<string, unknown>>;
		return rows as unknown as SubsystemLogRecord[];
	}

	async pruneSubsystemLogs(olderThanMs: number): Promise<{ removed: number }> {
		return this.deps.client.mutation(api.logs.pruneSubsystemLogs, {
			ownerId: this.deps.ownerId,
			olderThanMs,
		}) as unknown as Promise<{ removed: number }>;
	}

	async appendConfigAudit(entry: ConfigAuditInput): Promise<ConfigAuditRecord> {
		const e = entry as unknown as { sha256?: string; bytes?: number; ts?: string; pid?: number };
		if (typeof e.sha256 !== "string" || e.sha256.length === 0) {
			throw new Error("logs.appendConfigAudit: entry.sha256 is required");
		}
		const record = (await this.deps.client.mutation(api.logs.appendConfigAudit, {
			instanceId: this.deps.instanceId,
			ts: e.ts ?? new Date().toISOString(),
			sha256: e.sha256,
			bytes: e.bytes ?? 0,
			...(e.pid !== undefined ? { pid: e.pid } : {}),
		})) as Record<string, unknown>;
		return record as unknown as ConfigAuditRecord;
	}

	async verifyConfigAuditChain(): Promise<{ ok: boolean; brokenAt?: number }> {
		const rows = (await this.deps.client.query(api.logs.listConfigAudit, {
			instanceId: this.deps.instanceId,
		})) as Array<{ seq: number; lineHash: string; prevHash?: string }>;
		let previousHash: string | undefined;
		for (const row of rows) {
			if (previousHash !== undefined && row.prevHash !== previousHash) {
				return { ok: false, brokenAt: row.seq };
			}
			previousHash = row.lineHash;
		}
		return { ok: true };
	}

	async writeConfigHealth(snapshot: ConfigHealthRecord): Promise<void> {
		const s = snapshot as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.logs.writeConfigHealth, {
			ownerId: this.deps.ownerId,
			ts: (s.ts as string) ?? new Date().toISOString(),
			configPath: (s.configPath as string) ?? "convex://config",
			bytes: (s.bytes as number) ?? 0,
			sha256: (s.sha256 as string) ?? "",
			mtimeMs: (s.mtimeMs as number) ?? Date.now(),
			pid: (s.pid as number) ?? process.pid,
		});
	}

	async readConfigHealth(): Promise<ConfigHealthRecord | undefined> {
		const row = (await this.deps.client.query(api.logs.readConfigHealth, {
			ownerId: this.deps.ownerId,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as ConfigHealthRecord) : undefined;
	}

	subscribe(_filter: LogFilter, _cb: (e: SubsystemLogRecord) => void): Unsub {
		return () => undefined;
	}

	__unused = NotImplementedYet;
}
