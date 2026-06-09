// src/storage/convex/cron-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { getReactiveConvexClient } from "./client.js";

import { NotImplementedYet } from "../store.js";
import type {
	CronJob,
	CronJobState,
	CronRunLogEntry,
	CronStore,
	ReadCronRunLogOpts,
	Unsub,
} from "../store.js";

import { sealJson } from "../encryption.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

function jsonToBytes(value: unknown): ArrayBuffer {
	return sealJson(value);
}

export class ConvexCronStore implements CronStore {
	constructor(private readonly deps: Deps) {}

	async listJobs(filter?: { enabled?: boolean; query?: string; ownerOnly?: boolean }): Promise<CronJob[]> {
		const rows = (await this.deps.client.query(api.cron.listJobs, {
			ownerUserId: this.deps.ownerId,
			...(filter?.enabled !== undefined ? { enabledOnly: filter.enabled === true } : {}),
		})) as Array<Record<string, unknown>>;
		return rows as unknown as CronJob[];
	}

	async getJob(jobId: string): Promise<CronJob | null> {
		const row = (await this.deps.client.query(api.cron.getJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
		})) as Record<string, unknown> | null;
		return row ? (row as unknown as CronJob) : null;
	}

	async insertJob(job: CronJob): Promise<void> {
		const j = job as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.cron.insertJob, {
			jobId: (j.id as string) ?? (j.jobId as string),
			ownerUserId: this.deps.ownerId,
			name: (j.name as string) ?? "unnamed",
			enabled: (j.enabled as boolean) ?? true,
			scheduleKind: ((j.schedule as { kind?: string })?.kind as never) ?? "at",
			sessionTarget: (j.sessionTarget as string) ?? "main",
			payload: jsonToBytes(j.payload),
			createdByKind: ((j.createdBy as { kind?: string })?.kind as never) ?? "owner",
		});
	}

	async updateJob(jobId: string, mutate: (job: CronJob) => CronJob): Promise<CronJob> {
		const existing = await this.getJob(jobId);
		if (!existing) throw new Error(`cron: job ${jobId} not found`);
		const next = mutate(existing);
		const row = (await this.deps.client.mutation(api.cron.patchJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
			patch: next,
		})) as Record<string, unknown>;
		return row as unknown as CronJob;
	}

	async deleteJob(jobId: string): Promise<boolean> {
		return (await this.deps.client.mutation(api.cron.deleteJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
		})) as boolean;
	}

	async markJobRunning(jobId: string, runningAtMs: number): Promise<boolean> {
		return (await this.deps.client.mutation(api.cron.markRunning, {
			ownerUserId: this.deps.ownerId,
			jobId,
			runningAtMs,
		})) as boolean;
	}

	async recordJobOutcome(
		jobId: string,
		patch: { state: Partial<CronJobState>; deleteAfterApply: boolean },
	): Promise<CronJob | null> {
		if (patch.deleteAfterApply) {
			await this.deleteJob(jobId);
			return null;
		}
		const row = (await this.deps.client.mutation(api.cron.patchJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
			patch: patch.state,
		})) as Record<string, unknown>;
		return row as unknown as CronJob;
	}

	async appendRunLog(entry: CronRunLogEntry): Promise<void> {
		const e = entry as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.cron.appendRunLog, {
			ownerUserId: this.deps.ownerId,
			jobId: (e.jobId as string) ?? "",
			ts: (e.ts as number) ?? Date.now(),
			status: (e.status as never) ?? "ok",
		});
	}

	async listRunLog(jobId: string, opts: ReadCronRunLogOpts): Promise<CronRunLogEntry[]> {
		const rows = (await this.deps.client.query(api.cron.listRunLog, {
			ownerUserId: this.deps.ownerId,
			jobId,
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
		})) as Array<Record<string, unknown>>;
		return rows as unknown as CronRunLogEntry[];
	}

	async listIsolatedCronSessions(): Promise<
		Array<{ sessionKey: string; sessionId: string; lastUsedAt: string }>
	> {
		throw new NotImplementedYet("cron.listIsolatedCronSessions (use store.sessions.listEntries)");
	}

	async deleteIsolatedCronSession(): Promise<void> {
		throw new NotImplementedYet("cron.deleteIsolatedCronSession (use store.sessions.deleteEntry)");
	}

	async withMutation<T>(work: () => Promise<T>): Promise<T> {
		// Convex serialises mutations on the same document keys — no extra lock.
		return work();
	}

	subscribe(cb: (jobs: CronJob[]) => void): Unsub {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.cron.listJobs,
			{ ownerUserId: this.deps.ownerId },
			(rows) => {
				try {
					cb(rows as unknown as CronJob[]);
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
