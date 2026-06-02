/**
 * Gateway method signature catalogue (Step 24).
 *
 * Brand-scrubbed analogue of upstream's per-method params + result type
 * definitions. ONE authoritative file mapping every method name to its
 * `{ params, result }` shape. Step 18's `gateway-call.ts` re-exports
 * `GatewayMethodSignatures` from here; tool layers (Steps 19-23) and
 * handler layers (Step 25) consume the same types.
 *
 * The catalogue is INTENTIONALLY LIMITED to the methods Brigade's
 * runtime currently exposes (sessions / cron / approvals / health /
 * agent). Adding a new method = add an entry here + register a handler
 * at the gateway boot path.
 */

import type { SpawnSubagentMode, SpawnSubagentSandboxMode } from "../agents/subagent-registry.types.js";

/* ─── Sessions methods ──────────────────────────────────────────── */

export interface SessionsSendParams {
	sessionKey: string;
	message: string;
	thinking?: string;
	attachments?: ReadonlyArray<{ type: string; url: string }>;
	timeoutMs?: number;
	idempotencyKey?: string;
}

export interface SessionsSendResult {
	ok: boolean;
	runId?: string;
	messageSeq?: number;
	interruptedActiveRun?: boolean;
}

export interface SessionsSpawnParams {
	parentSessionKey: string;
	task: string;
	label?: string;
	agentId?: string;
	model?: string;
	thinking?: string;
	runTimeoutSeconds?: number;
	thread?: boolean;
	mode?: SpawnSubagentMode;
	cleanup?: "delete" | "keep";
	sandbox?: SpawnSubagentSandboxMode;
}

export interface SessionsSpawnResult {
	runId: string;
	childSessionKey: string;
	mode: SpawnSubagentMode;
}

export interface SessionsListParams {
	limit?: number;
	activeMinutes?: number;
	kinds?: ReadonlyArray<string>;
	spawnedBy?: string;
	agentId?: string;
	messageLimit?: number;
}

export interface SessionListRow {
	sessionKey: string;
	agentId?: string;
	kind?: string;
	channel?: string;
	subject?: string;
	model?: string;
	state?: string;
	startedAt?: number;
	endedAt?: number;
	runtimeMs?: number;
	updatedAt?: number;
	parentSessionKey?: string;
	label?: string;
	displayName?: string;
	contextTokens?: number;
	totalTokens?: number;
	estimatedCostUsd?: number;
}

export interface SessionsListResult {
	sessions: SessionListRow[];
	count: number;
}

export interface SessionsHistoryParams {
	sessionKey: string;
	limit?: number;
}

export interface SessionsHistoryResult {
	messages: ReadonlyArray<unknown>;
}

export interface SessionsAbortParams {
	sessionKey: string;
	runId?: string;
}

/**
 * `sessions.patch` — update metadata on an existing session entry.
 *
 * Used by Step 20's sub-agent spawn engine to write `spawnDepth`,
 * `spawnedBy`, `spawnedWorkspaceDir` (+ optional `subagentRole` /
 * `controlScope`) into the persistent session-store BEFORE the first
 * child turn runs. Without this, depth tracking lives only in the
 * in-memory `subagent-registry` and gets lost on restart.
 *
 * Patch semantics: shallow merge into the existing entry. The
 * `sessionId` field is read-only — supplying it has no effect.
 * `lastUsedAt` is always touched. If the entry doesn't exist yet,
 * the handler creates one (matching upstream's upsert semantics).
 */
export interface SessionsPatchParams {
	sessionKey: string;
	patch: {
		provider?: string;
		modelId?: string;
		authProfile?: string;
		thinkingLevel?: string;
		spawnedWorkspaceDir?: string;
		subagent?: {
			spawnDepth: number;
			spawnedBy: string;
			parentRunId?: string;
			label?: string;
			cleanup?: "delete" | "keep";
			spawnedAt: string;
			spawnedWorkspaceDir?: string;
		};
		[key: string]: unknown;
	};
}

export interface SessionsPatchResult {
	ok: boolean;
	created: boolean;
	sessionId?: string;
}

/* ─── Agent (turn dispatch) method ──────────────────────────────── */

export interface AgentParams {
	message: string;
	sessionKey?: string;
	sessionId?: string;
	agentId?: string;
	model?: string;
	provider?: string;
	channel?: string;
	to?: string;
	accountId?: string;
	threadId?: string | number;
	thinking?: string;
	deliver?: boolean;
	lane?: string;
	idempotencyKey: string;
	timeout?: number;
	label?: string;
	spawnedBy?: string;
	workspaceDir?: string;
	extraSystemPrompt?: string;
	bootstrapContextMode?: "full" | "lightweight";
}

export interface AgentResult {
	runId: string;
	status?: "accepted" | "ok" | "error";
	summary?: string;
	result?: unknown;
}

/* ─── Cron methods ──────────────────────────────────────────────── */

export interface CronAddParams {
	schedule: string;
	sessionKey: string;
	payload: string;
}

export interface CronAddResult {
	scheduleId: string;
}

export type CronListParams = Record<string, never>;

export interface CronListResult {
	schedules: ReadonlyArray<{ id: string; schedule: string; sessionKey: string }>;
}

export interface CronRemoveParams {
	scheduleId: string;
}

export interface CronRemoveResult {
	ok: boolean;
}

/* ─── Approvals methods ─────────────────────────────────────────── */

export interface ApprovalsRespondParams {
	approvalId: string;
	decision: "allow-once" | "allow-always" | "allow-pattern" | "deny";
}

export interface ApprovalsRespondResult {
	ok: boolean;
}

/* ─── Health + system methods ───────────────────────────────────── */

export type HealthParams = Record<string, never>;

export interface HealthResult {
	status: "ok" | "degraded" | "unavailable";
	uptimeMs: number;
	versions?: { brigade: string; protocol: number };
	channels?: Record<string, { state?: string }>;
}

/* ─── Authoritative catalogue ───────────────────────────────────── */

export interface GatewayMethodSignatures {
	"sessions.send": { params: SessionsSendParams; result: SessionsSendResult };
	"sessions.spawn": { params: SessionsSpawnParams; result: SessionsSpawnResult };
	"sessions.list": { params: SessionsListParams; result: SessionsListResult };
	"sessions.history": { params: SessionsHistoryParams; result: SessionsHistoryResult };
	"sessions.abort": { params: SessionsAbortParams; result: { ok: boolean } };
	"sessions.patch": { params: SessionsPatchParams; result: SessionsPatchResult };
	agent: { params: AgentParams; result: AgentResult };
	"cron.add": { params: CronAddParams; result: CronAddResult };
	"cron.list": { params: CronListParams; result: CronListResult };
	"cron.remove": { params: CronRemoveParams; result: CronRemoveResult };
	"approvals.respond": { params: ApprovalsRespondParams; result: ApprovalsRespondResult };
	health: { params: HealthParams; result: HealthResult };
}

export type GatewayMethodName = keyof GatewayMethodSignatures;
