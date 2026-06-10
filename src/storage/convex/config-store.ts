// src/storage/convex/config-store.ts
//
// ConvexConfigStore — convex-mode adapter for the brigadeConfig table.
// Mirrors LocalConfigStore byte-for-semantically (same RevToken contract,
// same OCC behaviour) but stores rows in Convex instead of brigade.json.
//
// Encryption — the schema has `encryptedGatewayAuthToken` / `encrypted-
// GatewayAuthPassword` byte columns; PR16 ships the unencrypted path
// (gateway tokens stay in the regular `gateway` JSON column for now).
// The DEK-wrapped encryption seam lands when the `auth` sub-store does
// — same per-owner DEK is reused.

import { createHash } from "node:crypto";

import type { ConvexHttpClient } from "convex/browser";

import type { BrigadeConfig } from "../../config/types.js";
import { api } from "../../../convex/_generated/api.js";

import { getReactiveConvexClient } from "./client.js";

import { ConflictError } from "../store.js";
import type {
	ConfigStore,
	RevToken,
	Unsub,
	WriteResult,
} from "../store.js";

interface Deps {
	client: ConvexHttpClient;
	instanceId: string;
}

function shaOf(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value ?? null))
		.digest("hex");
}

/** Build the BrigadeConfig payload + sha256 from a Convex row. */
function rowToConfig(row: Record<string, unknown> | null): {
	value: BrigadeConfig;
	rev: RevToken;
} {
	if (!row) {
		// First boot — no row yet. Return an empty config with a stable rev so
		// callers can write into it without an OCC conflict.
		const value = {} as BrigadeConfig;
		return { value, rev: shaOf(value) as RevToken };
	}
	// Strip Convex bookkeeping fields. The schema captures the brigade.json
	// shape in domain columns (agents, gateway, session, …); compose them
	// back into a BrigadeConfig.
	const out: Record<string, unknown> = {};
	for (const key of [
		"agents",
		"gateway",
		"session",
		"tools",
		"auth",
		"plugins",
		"skills",
		"channels",
		"bindings",
		"org",
		"wizard",
		"meta",
		"defaults",
	]) {
		const v = (row as Record<string, unknown>)[key];
		if (v !== undefined) out[key] = v;
	}
	// Restore any unknown top-level keys parked in `extra` (disk-path
	// round-trip parity — io.ts preserves unknown sections).
	const extra = (row as { extra?: Record<string, unknown> }).extra;
	if (extra && typeof extra === "object") {
		for (const [k, v] of Object.entries(extra)) {
			if (out[k] === undefined) out[k] = v;
		}
	}
	const sha = (row as { contentSha256?: string }).contentSha256;
	return {
		value: out as BrigadeConfig,
		rev: (sha ?? shaOf(out)) as RevToken,
	};
}

export class ConvexConfigStore implements ConfigStore {
	constructor(private readonly deps: Deps) {}

	async read(): Promise<{ value: BrigadeConfig; rev: RevToken }> {
		const row = (await this.deps.client.query(api.config.read, {
			instanceId: this.deps.instanceId,
		})) as Record<string, unknown> | null;
		return rowToConfig(row);
	}

	async write(
		cfg: BrigadeConfig,
		opts?: { expectedRev?: RevToken },
	): Promise<WriteResult> {
		const sha = shaOf(cfg);
		const bytes = Buffer.byteLength(JSON.stringify(cfg), "utf8");
		// Collect any top-level keys NOT given a named column into `extra`, so
		// the disk path's unknown-key round-trip is preserved byte-for-shape.
		const NAMED = new Set([
			"agents", "gateway", "session", "tools", "auth", "plugins", "skills",
			"channels", "bindings", "org", "wizard", "meta", "defaults", "version",
		]);
		const extra: Record<string, unknown> = {};
		let hasExtra = false;
		for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
			if (NAMED.has(k) || v === undefined) continue;
			extra[k] = v;
			hasExtra = true;
		}
		try {
			await this.deps.client.mutation(api.config.write, {
				instanceId: this.deps.instanceId,
				agents:   (cfg as { agents?: unknown }).agents ?? undefined,
				gateway:  (cfg as { gateway?: unknown }).gateway ?? undefined,
				session:  (cfg as { session?: unknown }).session ?? undefined,
				tools:    (cfg as { tools?: unknown }).tools ?? undefined,
				auth:     (cfg as { auth?: unknown }).auth ?? undefined,
				plugins:  (cfg as { plugins?: unknown }).plugins ?? undefined,
				skills:   (cfg as { skills?: unknown }).skills ?? undefined,
				channels: (cfg as { channels?: unknown }).channels ?? undefined,
				bindings: (cfg as { bindings?: unknown }).bindings ?? undefined,
				org:      (cfg as { org?: unknown }).org ?? undefined,
				wizard:   (cfg as { wizard?: unknown }).wizard ?? undefined,
				meta:     (cfg as { meta?: unknown }).meta ?? undefined,
				defaults: (cfg as { defaults?: unknown }).defaults ?? undefined,
				...(hasExtra ? { extra } : {}),
				contentSha256: sha,
				bytes,
				...(opts?.expectedRev !== undefined
					? { expectedSha256: opts.expectedRev as string }
					: {}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (opts?.expectedRev && msg.includes("OCC conflict")) {
				const m = /on-disk is ([0-9a-f]{64})/.exec(msg);
				const actual = (m?.[1] ?? "") as RevToken;
				throw new ConflictError(opts.expectedRev, actual);
			}
			throw err;
		}
		return { rev: sha as RevToken, writtenAt: Date.now() };
	}

	async mutate(
		fn: (current: BrigadeConfig) => BrigadeConfig | Promise<BrigadeConfig>,
	): Promise<BrigadeConfig> {
		// Read-modify-write with OCC retry. Three attempts is enough — Convex
		// transactions on the same row contend rarely, and beyond that a
		// genuine conflict deserves operator attention rather than a tight
		// retry loop.
		let attempts = 3;
		while (attempts-- > 0) {
			const { value, rev } = await this.read();
			const next = await fn(value);
			try {
				await this.write(next, { expectedRev: rev });
				return next;
			} catch (err) {
				if (err instanceof ConflictError && attempts > 0) continue;
				throw err;
			}
		}
		throw new Error("ConvexConfigStore.mutate: exhausted retries");
	}

	subscribe(cb: (cfg: BrigadeConfig, rev: RevToken) => void): Unsub {
		// Reactive subscription via Convex live-query. On every server-side
		// change to this instance's config row, the callback fires with the
		// fresh value.
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.config.read,
			{ instanceId: this.deps.instanceId },
			(row) => {
				try {
					const { value, rev } = rowToConfig(row as Record<string, unknown> | null);
					cb(value, rev);
				} catch {
					// One bad subscriber doesn't kill the stream; swallow.
				}
			},
		);
		return () => {
			try {
				unsub();
			} catch {
				// Idempotent unsub.
			}
		};
	}

	async listBackups(): Promise<
		Array<{ slot: number; sha256: string; mtimeMs: number; bytes: number }>
	> {
		// brigadeConfigBackups table exists in the schema but isn't populated
		// until a separate "snapshot" call is wired. Return empty for now;
		// the doctor + restore flow will surface this when needed.
		return [];
	}

	async restoreBackup(_slot: number): Promise<BrigadeConfig> {
		throw new Error(
			"ConvexConfigStore.restoreBackup not wired yet — restore via the dashboard or re-run `brigade onboard`.",
		);
	}
}
