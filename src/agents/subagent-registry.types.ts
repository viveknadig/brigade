/**
 * `SubagentRunRecord` — the in-memory shape the sub-agent registry tracks
 * for every spawn.
 *
 * Brand-scrubbed lift of upstream's `src/agents/subagent-registry.types.ts`.
 * Supporting types (`DeliveryContext`, `SubagentRunOutcome`, `SpawnSubagentMode`)
 * are declared inline here for now — they get their own modules as later
 * steps land:
 *
 *   - `DeliveryContext` → Step 16 (channel manager).
 *   - `SubagentRunOutcome` → Step 20 (subagent-spawn engine).
 *   - `SpawnSubagentMode` → Step 20 (subagent-spawn engine).
 *
 * Until those steps materialise, the placeholders here let the registry
 * compile + run with no consumer change required when the dedicated
 * modules show up.
 */

import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";

/**
 * Spawn mode flag.
 *
 *   - `"run"`     → one-shot: child runs, announces result, registry archives.
 *   - `"session"` → persistent: child stays available for thread follow-up.
 */
export type SpawnSubagentMode = "run" | "session";

/**
 * Sandbox-inheritance flag for the spawn request.
 *
 *   - `"inherit"` → child inherits the parent's sandbox state.
 *   - `"require"` → child MUST be sandboxed; spawn fails if the target
 *      runtime is not sandbox-capable.
 */
export type SpawnSubagentSandboxMode = "inherit" | "require";

/**
 * Per-run outcome the registry stamps when the lifecycle reports the
 * sub-agent finished. The `error`/`text` payload survives long enough
 * for the announcer + the parent's `tool_result` capture.
 */
export type SubagentRunOutcome =
	| { status: "ok"; text?: string }
	| { status: "error"; error: string; text?: string }
	| { status: "timeout"; text?: string };

export type SubagentRunRecord = {
	runId: string;
	childSessionKey: string;
	controllerSessionKey?: string;
	requesterSessionKey: string;
	requesterOrigin?: DeliveryContext;
	requesterDisplayKey: string;
	task: string;
	cleanup: "delete" | "keep";
	label?: string;
	model?: string;
	workspaceDir?: string;
	runTimeoutSeconds?: number;
	spawnMode?: SpawnSubagentMode;
	createdAt: number;
	startedAt?: number;
	sessionStartedAt?: number;
	accumulatedRuntimeMs?: number;
	endedAt?: number;
	outcome?: SubagentRunOutcome;
	archiveAtMs?: number;
	cleanupCompletedAt?: number;
	cleanupHandled?: boolean;
	suppressAnnounceReason?: "steer-restart" | "killed";
	expectsCompletionMessage?: boolean;
	announceRetryCount?: number;
	lastAnnounceRetryAt?: number;
	endedReason?: SubagentLifecycleEndedReason;
	wakeOnDescendantSettle?: boolean;
	frozenResultText?: string | null;
	frozenResultCapturedAt?: number;
	fallbackFrozenResultText?: string | null;
	fallbackFrozenResultCapturedAt?: number;
	endedHookEmittedAt?: number;
	completionAnnouncedAt?: number;
	attachmentsDir?: string;
	attachmentsRootDir?: string;
	retainAttachmentsOnKeep?: boolean;
};
