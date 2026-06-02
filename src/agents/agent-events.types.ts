/**
 * Agent-events type catalogue (Step 18).
 *
 * Brand-scrubbed analogue of upstream's `src/infra/agent-events.ts` type
 * definitions. Separates types from the bus implementation so callers
 * that only need the type shape (channel adapters, gateway clients, test
 * fixtures) don't pull the singleton state in.
 *
 * Event-stream contract (every emitted payload carries):
 *
 *   - `runId`      — stable id for the agent turn that produced the event.
 *                    Sequence numbers are monotonic per-runId; consumers
 *                    can detect dropped events by gap.
 *   - `seq`        — monotonic per-runId. First event for a run is `1`.
 *   - `stream`     — high-level kind ("lifecycle" | "item" | "approval" |
 *                    "command_output" | "patch" | "subagent_lifecycle" |
 *                    "heartbeat" | …). String-literal-but-extensible.
 *   - `ts`         — ms-since-epoch when the event was emitted.
 *   - `data`       — stream-specific payload; typed by the per-stream
 *                    `*EventData` aliases below.
 *   - `sessionKey?`— optional session affinity. The bus may strip this on
 *                    runs with `isControlUiVisible: false` so a
 *                    background heartbeat doesn't leak its sessionKey to
 *                    control-UI WebSocket clients.
 */

/** Open-string stream id. Add a literal to the union for type-narrowing. */
export type AgentEventStream =
	| "lifecycle"
	| "item"
	| "approval"
	| "command_output"
	| "patch"
	| "subagent_lifecycle"
	| "heartbeat"
	| "session_lifecycle"
	| (string & {});

/** Phase markers for "item" events (tool call lifecycle). */
export type AgentItemEventPhase = "start" | "update" | "end";
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
export type AgentItemEventKind =
	| "tool"
	| "command"
	| "patch"
	| "search"
	| "analysis"
	| (string & {});

export type AgentItemEventData = {
	itemId: string;
	phase: AgentItemEventPhase;
	kind: AgentItemEventKind;
	title: string;
	status: AgentItemEventStatus;
	name?: string;
	meta?: string;
	toolCallId?: string;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	summary?: string;
	progressText?: string;
};

/** Phases for "approval" events. */
export type AgentApprovalEventPhase = "requested" | "resolved";
export type AgentApprovalEventStatus =
	| "pending"
	| "unavailable"
	| "approved"
	| "denied"
	| "failed";
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

export type AgentApprovalEventData = {
	phase: AgentApprovalEventPhase;
	kind: AgentApprovalEventKind;
	status: AgentApprovalEventStatus;
	title: string;
	itemId?: string;
	toolCallId?: string;
	approvalId?: string;
	command?: string;
	host?: string;
	reason?: string;
	message?: string;
};

/** Streamed bash-style stdout/stderr from `command_output` stream. */
export type AgentCommandOutputEventData = {
	itemId: string;
	phase: "delta" | "end";
	title: string;
	toolCallId: string;
	name?: string;
	output?: string;
	status?: AgentItemEventStatus | "running";
	exitCode?: number | null;
	durationMs?: number;
	cwd?: string;
};

/** Patch-summary event payload (write/edit diff). */
export type AgentPatchSummaryEventData = {
	itemId: string;
	phase: "end";
	title: string;
	toolCallId: string;
	name?: string;
	added: string[];
	modified: string[];
	deleted: string[];
	summary: string;
};

/** Sub-agent lifecycle event (started, ended, progress). */
export type SubagentLifecycleEventData = {
	kind: "subagent_started" | "subagent_ended" | "subagent_progress";
	childSessionKey: string;
	requesterSessionKey?: string;
	runId: string;
	reason?: string;
	outcome?: "ok" | "error" | "timeout";
	error?: string;
	progress?: number;
};

/** Heartbeat-fired event. */
export type HeartbeatEventData = {
	kind: "heartbeat_fired";
	reason: string;
	agentId: string;
	sessionKey: string;
	consumedEventCount: number;
};

/** Per-session lifecycle (registered / state-change / unregistered). */
export type SessionLifecycleEventData = {
	kind: "session_registered" | "session_state_changed" | "session_unregistered";
	sessionKey: string;
	agentId?: string;
	previousState?: string;
	newState?: string;
};

/** Top-level event payload as emitted on the bus. */
export type AgentEventPayload = {
	runId: string;
	seq: number;
	stream: AgentEventStream;
	ts: number;
	data: Record<string, unknown>;
	sessionKey?: string;
};

/** Per-run context the bus keeps for sessionKey enrichment + leak guards. */
export type AgentRunContext = {
	sessionKey?: string;
	isHeartbeat?: boolean;
	/**
	 * When `false`, the bus strips `sessionKey` from emitted payloads so
	 * background work (heartbeats, cron fires) doesn't leak through to
	 * control-UI WebSocket subscribers that should only see operator-
	 * facing turns.
	 */
	isControlUiVisible?: boolean;
	registeredAt?: number;
	lastActiveAt?: number;
};
