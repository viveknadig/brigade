/**
 * Per-agent heartbeat interval scheduler.
 *
 * Brigade-native analogue of upstream's wall-clock heartbeat scheduler.
 * Reads `cfg.agents.<id>.heartbeat.intervalMs` (and the `defaults` fallback)
 * to build a `Map<agentId, AgentSchedule>` of agents that opt into
 * periodic heartbeats. On each tick the scheduler invokes the supplied
 * `onInterval(agentId)` callback for every agent whose `nextDueMs` has
 * elapsed; the callback is expected to call into Step 13's
 * `requestHeartbeatNow(...)` which the runner picks up.
 *
 * Phase offsets are deterministic per agent (SHA-256 of a fixed seed +
 * the agent id, mod intervalMs) so a Brigade restart resumes its agents
 * on the same phase rather than thundering at the same instant. The
 * seed defaults to a stable string; tests can override via
 * `BRIGADE_HEARTBEAT_SEED` env to nail down phase positions.
 *
 * Lifecycle:
 *
 *   const sched = createHeartbeatScheduler({ onInterval });
 *   sched.updateConfig(cfg);     // seed the per-agent map
 *   sched.start();               // arm the wall-clock timer
 *   // ... gateway runs ...
 *   sched.stop();                // clear the timer
 *
 * Hot config reload is supported: `updateConfig(cfg)` recomputes the
 * agent map. Agents whose interval changed get a new `nextDueMs`;
 * agents whose interval stayed the same keep their existing schedule
 * so the phase doesn't reset.
 */

import { createHash } from "node:crypto";

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { BrigadeConfig } from "../config/types.js";

const log = createSubsystemLogger("agents/heartbeat-scheduler");

interface AgentSchedule {
	agentId: string;
	intervalMs: number;
	phaseMs: number;
	nextDueMs: number;
	sessionKey?: string;
}

export interface HeartbeatSchedulerDeps {
	/**
	 * Invoked when an agent's `nextDueMs` elapses. Implementation should
	 * call `requestHeartbeatNow({reason: "interval", agentId, sessionKey})`
	 * from Step 13's wake layer so the runner picks up the intent.
	 */
	onInterval: (params: { agentId: string; sessionKey?: string }) => void;
}

export interface HeartbeatScheduler {
	start: () => void;
	stop: () => void;
	updateConfig: (cfg: BrigadeConfig) => void;
	getScheduleSnapshot: () => Array<{ agentId: string; intervalMs: number; nextDueMs: number }>;
}

type SchedulerState = {
	agents: Map<string, AgentSchedule>;
	timer: NodeJS.Timeout | null;
	stopped: boolean;
};

const SCHEDULER_STATE_KEY = Symbol.for("brigade.heartbeatScheduler.state");

function createState(): SchedulerState {
	return { agents: new Map(), timer: null, stopped: false };
}

function getState(): SchedulerState {
	return resolveGlobalSingleton<SchedulerState>(SCHEDULER_STATE_KEY, createState);
}

function resolvePhaseMs(agentId: string, intervalMs: number): number {
	const seed = process.env.BRIGADE_HEARTBEAT_SEED?.trim() || "brigade";
	const digest = createHash("sha256").update(`${seed}:${agentId}`).digest();
	return digest.readUInt32BE(0) % Math.max(1, intervalMs);
}

function computeNextDueMs(now: number, intervalMs: number, phaseMs: number): number {
	const offsetIntoCycle = (now - phaseMs) % intervalMs;
	const delta = offsetIntoCycle <= 0 ? -offsetIntoCycle : intervalMs - offsetIntoCycle;
	return now + (delta || intervalMs);
}

function readAgentHeartbeatConfig(
	cfg: BrigadeConfig,
	agentId: string,
): { intervalMs?: number; sessionKey?: string } | undefined {
	const agents = cfg.agents as
		| Record<
				string,
				| { heartbeat?: { intervalMs?: number; sessionKey?: string } }
				| undefined
		  >
		| undefined;
	const agentEntry = agents?.[agentId];
	if (agentEntry && typeof agentEntry === "object" && "heartbeat" in agentEntry) {
		const hb = (agentEntry as { heartbeat?: { intervalMs?: number; sessionKey?: string } }).heartbeat;
		if (hb && typeof hb === "object") {
			return {
				intervalMs: typeof hb.intervalMs === "number" ? hb.intervalMs : undefined,
				sessionKey: typeof hb.sessionKey === "string" ? hb.sessionKey : undefined,
			};
		}
	}
	const defaults = agents?.defaults as
		| { heartbeat?: { intervalMs?: number; sessionKey?: string } }
		| undefined;
	if (defaults?.heartbeat && typeof defaults.heartbeat === "object") {
		return {
			intervalMs:
				typeof defaults.heartbeat.intervalMs === "number"
					? defaults.heartbeat.intervalMs
					: undefined,
			sessionKey:
				typeof defaults.heartbeat.sessionKey === "string"
					? defaults.heartbeat.sessionKey
					: undefined,
		};
	}
	return undefined;
}

function listAgentIds(cfg: BrigadeConfig): string[] {
	const agents = cfg.agents as Record<string, unknown> | undefined;
	if (!agents || typeof agents !== "object") return [];
	const out: string[] = [];
	for (const key of Object.keys(agents)) {
		if (key === "defaults") continue;
		if (!key.trim()) continue;
		out.push(key.trim());
	}
	return out;
}

export function createHeartbeatScheduler(deps: HeartbeatSchedulerDeps): HeartbeatScheduler {
	function scheduleNext(): void {
		const state = getState();
		if (state.stopped) {
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			return;
		}
		if (state.agents.size === 0) {
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
			return;
		}
		const now = Date.now();
		let earliest = Number.POSITIVE_INFINITY;
		for (const agent of state.agents.values()) {
			if (agent.nextDueMs < earliest) earliest = agent.nextDueMs;
		}
		if (!Number.isFinite(earliest)) return;
		const delay = Math.max(0, earliest - now);
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			void onTimerFire();
		}, delay);
		state.timer.unref?.();
	}

	async function onTimerFire(): Promise<void> {
		const state = getState();
		state.timer = null;
		if (state.stopped) return;
		const now = Date.now();
		for (const agent of state.agents.values()) {
			if (now < agent.nextDueMs) continue;
			try {
				deps.onInterval({ agentId: agent.agentId, sessionKey: agent.sessionKey });
			} catch (err) {
				log.warn("heartbeat interval callback threw", {
					agentId: agent.agentId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			// Advance using the agent's phase so the schedule stays anchored
			// rather than drifting on each tick.
			agent.nextDueMs = computeNextDueMs(now + 1, agent.intervalMs, agent.phaseMs);
		}
		scheduleNext();
	}

	const scheduler: HeartbeatScheduler = {
		start: () => {
			const state = getState();
			state.stopped = false;
			scheduleNext();
		},
		stop: () => {
			const state = getState();
			state.stopped = true;
			if (state.timer) clearTimeout(state.timer);
			state.timer = null;
		},
		updateConfig: (cfg: BrigadeConfig) => {
			const state = getState();
			const now = Date.now();
			const nextAgents = new Map<string, AgentSchedule>();
			for (const agentId of listAgentIds(cfg)) {
				const hb = readAgentHeartbeatConfig(cfg, agentId);
				const intervalMs = hb?.intervalMs;
				if (!intervalMs || !Number.isFinite(intervalMs) || intervalMs <= 0) continue;
				const phaseMs = resolvePhaseMs(agentId, intervalMs);
				const prev = state.agents.get(agentId);
				const preserveSchedule =
					prev && prev.intervalMs === intervalMs && prev.phaseMs === phaseMs;
				const nextDueMs = preserveSchedule
					? prev.nextDueMs
					: computeNextDueMs(now, intervalMs, phaseMs);
				nextAgents.set(agentId, {
					agentId,
					intervalMs,
					phaseMs,
					nextDueMs,
					...(hb?.sessionKey ? { sessionKey: hb.sessionKey } : {}),
				});
			}
			state.agents.clear();
			for (const [id, schedule] of nextAgents) state.agents.set(id, schedule);
			scheduleNext();
		},
		getScheduleSnapshot: () => {
			const state = getState();
			return Array.from(state.agents.values()).map((agent) => ({
				agentId: agent.agentId,
				intervalMs: agent.intervalMs,
				nextDueMs: agent.nextDueMs,
			}));
		},
	};

	return scheduler;
}

/** Test-only — clear scheduler state. */
export function resetHeartbeatSchedulerForTests(): void {
	const state = getState();
	if (state.timer) clearTimeout(state.timer);
	state.agents.clear();
	state.timer = null;
	state.stopped = false;
}
