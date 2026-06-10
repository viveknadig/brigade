// src/storage/convex/message-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { NotImplementedYet } from "../store.js";
import type {
	MessageStore,
	PiTranscriptRecord,
	RepairReport,
	SystemEvent,
	Unsub,
} from "../store.js";

import { open as openSealed, sealJson } from "../encryption.js";
import { BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE } from "../../sessions/bootstrap-marker.js";

interface Deps { client: ConvexHttpClient }

function jsonToBytes(value: unknown): ArrayBuffer {
	return sealJson(value);
}
function bytesToJson<T>(b: ArrayBuffer | null | undefined): T | undefined {
	if (!b) return undefined;
	try {
		return JSON.parse(openSealed(b).toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

export class ConvexMessageStore implements MessageStore {
	constructor(private readonly deps: Deps) {}

	async appendRecord(
		agentId: string,
		sessionId: string,
		record: PiTranscriptRecord,
	): Promise<void> {
		const customType = (record as { customType?: unknown }).customType;
		await this.deps.client.mutation(api.messages.appendRecord, {
			agentId,
			sessionId,
			type: record.type,
			...(typeof customType === "string" ? { customType } : {}),
			payload: jsonToBytes(record),
		});
	}

	async appendRecordsBatch(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		if (records.length === 0) return;
		await this.deps.client.mutation(api.messages.appendRecordsBatch, {
			agentId,
			sessionId,
			records: records.map((record) => {
				const customType = (record as { customType?: unknown }).customType;
				return {
					type: record.type,
					...(typeof customType === "string" ? { customType } : {}),
					payload: jsonToBytes(record),
				};
			}),
		});
	}

	async replaceTranscript(
		agentId: string,
		sessionId: string,
		records: PiTranscriptRecord[],
	): Promise<void> {
		await this.deps.client.mutation(api.messages.replaceTranscript, {
			agentId,
			sessionId,
			records: records.map((record) => {
				const customType = (record as { customType?: unknown }).customType;
				return {
					type: record.type,
					...(typeof customType === "string" ? { customType } : {}),
					payload: jsonToBytes(record),
				};
			}),
		});
	}

	async readTranscript(
		agentId: string,
		sessionId: string,
		opts?: { limit?: number; tailBytes?: number },
	): Promise<PiTranscriptRecord[]> {
		// Page by seq cursor until we've satisfied `want` or the transcript is
		// exhausted. A single `take(limit)` truncates a session longer than the
		// per-query read cap; migrate asks for "all" (a huge limit) and MUST get
		// every record so the copy is faithful.
		const want = opts?.limit && opts.limit > 0 ? opts.limit : 1000;
		const PAGE = 4000;
		const out: PiTranscriptRecord[] = [];
		let afterSeq: number | undefined;
		while (out.length < want) {
			const pageSize = Math.min(PAGE, want - out.length);
			const rows = (await this.deps.client.query(api.messages.readTranscript, {
				agentId,
				sessionId,
				limit: pageSize,
				...(afterSeq !== undefined ? { afterSeq } : {}),
			})) as Array<{ payload: ArrayBuffer; seq: number }>;
			if (rows.length === 0) break;
			for (const row of rows) {
				const parsed = bytesToJson<PiTranscriptRecord>(row.payload);
				if (parsed) out.push(parsed);
			}
			afterSeq = rows[rows.length - 1]!.seq;
			// A short page means the index range is drained — stop.
			if (rows.length < pageSize) break;
		}
		return out;
	}

	async hasBootstrapDelivered(agentId: string, sessionId: string): Promise<boolean> {
		// Mirror the disk walk (hasDeliveredBootstrapToSession): scan
		// newest-first and honour compaction-invalidation — a `compaction`
		// record newer than the marker means the bootstrap context was likely
		// compacted out, so the next turn must re-deliver. Walking the
		// newest-first tail, the FIRST marker-or-compaction encountered decides:
		// marker → delivered (still valid); compaction → invalidated.
		const rows = (await this.deps.client.query(api.messages.readMarkerTail, {
			agentId,
			sessionId,
		})) as Array<{ type: string; customType?: string }>;
		for (const r of rows) {
			if (r.type === "compaction") return false;
			if (r.type === "custom" && r.customType === BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE) {
				return true;
			}
		}
		return false;
	}

	async markBootstrapDelivered(agentId: string, sessionId: string): Promise<void> {
		await this.appendRecord(agentId, sessionId, {
			type: "custom",
			customType: BRIGADE_BOOTSTRAP_DELIVERED_CUSTOM_TYPE,
			data: { timestamp: new Date().toISOString() },
		} as unknown as PiTranscriptRecord);
	}

	async deleteTranscript(agentId: string, sessionId: string): Promise<void> {
		await this.deps.client.mutation(api.messages.deleteTranscript, { agentId, sessionId });
	}

	async repairIfNeeded(_agentId: string, _sessionId: string): Promise<RepairReport> {
		// Convex rows can't be torn mid-write — the storage layer guarantees
		// atomicity per mutation. Repair is a no-op in convex mode.
		return { repaired: false, reason: "convex transactional storage; no torn writes" } as unknown as RepairReport;
	}

	async withWriteLock<T>(
		_agentId: string,
		_sessionId: string,
		fn: () => Promise<T>,
		_opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		// Convex mutations on the same row keys are linearised by the backend.
		// Convex mode achieves the same property without an in-process lock.
		return fn();
	}

	subscribe(_sessionId: string, _cb: (msg: PiTranscriptRecord) => void): Unsub {
		// Convex live-query subscription is a follow-up.
		return () => undefined;
	}

	async inboxEnqueue(sessionKey: string, event: SystemEvent): Promise<boolean> {
		const e = event as unknown as {
			text?: string;
			contextKey?: string | null;
			deliveryContext?: unknown;
			trusted?: boolean;
		};
		const text = typeof e.text === "string" ? e.text : "";
		if (!text) return false;
		const ts = (e as { ts?: number }).ts;
		await this.deps.client.mutation(api.messages.inboxEnqueue, {
			sessionKey,
			text: jsonToBytes(text),
			...(typeof ts === "number" ? { ts } : {}),
			...(e.contextKey !== undefined && e.contextKey !== null ? { contextKey: e.contextKey } : {}),
			...(e.deliveryContext !== undefined ? { deliveryContext: e.deliveryContext } : {}),
			trusted: e.trusted !== false,
		});
		return true;
	}

	async inboxDrain(sessionKey: string): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.mutation(api.messages.inboxDrain, {
			sessionKey,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			trusted: r.trusted,
		})) as unknown as SystemEvent[];
	}

	async inboxConsumePrefix(
		sessionKey: string,
		prefix: readonly SystemEvent[],
	): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.mutation(api.messages.inboxConsumePrefix, {
			sessionKey,
			prefixLength: prefix.length,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted?: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			...(r.trusted !== undefined ? { trusted: r.trusted } : {}),
		})) as unknown as SystemEvent[];
	}

	async inboxPeek(sessionKey: string): Promise<SystemEvent[]> {
		const rows = (await this.deps.client.query(api.messages.inboxPeek, {
			sessionKey,
		})) as Array<{ text: ArrayBuffer; ts: number; contextKey?: string; deliveryContext?: unknown; trusted?: boolean }>;
		return rows.map((r) => ({
			text: bytesToJson<string>(r.text) ?? "",
			ts: r.ts,
			...(r.contextKey !== undefined ? { contextKey: r.contextKey } : {}),
			...(r.deliveryContext !== undefined ? { deliveryContext: r.deliveryContext } : {}),
			...(r.trusted !== undefined ? { trusted: r.trusted } : {}),
		})) as unknown as SystemEvent[];
	}

	async inboxHasEvents(sessionKey: string): Promise<boolean> {
		return (await this.deps.client.query(api.messages.inboxHasEvents, {
			sessionKey,
		})) as boolean;
	}
}
