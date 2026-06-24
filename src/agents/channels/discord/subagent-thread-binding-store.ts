/**
 * Phase 6 — Discord sub-agent thread-binding STORE (dependency-light).
 *
 * The binding registry lives in its own module — separate from the
 * materializer (`subagent-thread-binding.ts`, which transitively pulls in the
 * Discord REST + connection surface) — so hot paths can cheaply check "does
 * this child have a thread binding?" WITHOUT importing discord.js / the REST
 * layer. The completion bridge consults `hasDiscordSubagentThreadBinding`
 * synchronously and only lazy-imports the heavy materializer when a farewell
 * is actually owed.
 *
 * Brigade idiom: the binding IS session metadata — an in-process map keyed by
 * the child session key. No bindings file, no webhook pool, no ACP.
 */

import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";

/**
 * One stored sub-agent → thread binding. The child session key is the map key;
 * this record carries what the completion + farewell paths need to deliver into
 * the thread without re-resolving the spawn origin.
 */
export interface DiscordSubagentThreadBinding {
	/** The child sub-agent's session key (`…:thread:<id>`). The map key. */
	childSessionKey: string;
	/** The created Discord thread channel id. */
	threadId: string;
	/** The parent (originating) Discord channel id the thread hangs under. */
	parentChannelId: string;
	/** Discord account id (multi-account). */
	accountId: string;
	/** Resolved agent id running in the thread (for the farewell text). */
	agentId: string;
	/** Optional spawn label (surfaced in intro/farewell). */
	label?: string;
	/** Epoch ms the binding was created. */
	boundAt: number;
}

interface DiscordSubagentThreadBindingState {
	/** child session key → binding. */
	byChildSessionKey: Map<string, DiscordSubagentThreadBinding>;
}

const STATE_KEY = Symbol.for("brigade.discord.subagentThreadBindings");

function getState(): DiscordSubagentThreadBindingState {
	return resolveGlobalSingleton<DiscordSubagentThreadBindingState>(STATE_KEY, () => ({
		byChildSessionKey: new Map(),
	}));
}

export function rememberDiscordSubagentThreadBinding(binding: DiscordSubagentThreadBinding): void {
	const key = binding.childSessionKey?.trim();
	if (!key) return;
	getState().byChildSessionKey.set(key, binding);
}

export function getDiscordSubagentThreadBinding(
	childSessionKey: string | undefined | null,
): DiscordSubagentThreadBinding | undefined {
	const key = childSessionKey?.trim();
	if (!key) return undefined;
	return getState().byChildSessionKey.get(key);
}

/** Cheap synchronous presence check — no heavy module load needed. */
export function hasDiscordSubagentThreadBinding(childSessionKey: string | undefined | null): boolean {
	const key = childSessionKey?.trim();
	if (!key) return false;
	return getState().byChildSessionKey.has(key);
}

export function forgetDiscordSubagentThreadBinding(childSessionKey: string | undefined | null): boolean {
	const key = childSessionKey?.trim();
	if (!key) return false;
	return getState().byChildSessionKey.delete(key);
}

export function listDiscordSubagentThreadBindings(): DiscordSubagentThreadBinding[] {
	return [...getState().byChildSessionKey.values()];
}

/**
 * Startup reconcile: drop any binding whose child session is no longer known to
 * the spawn registry (the run completed + was archived across a reload). Cheap —
 * a Map walk. Returns the number dropped. Never deletes the thread itself.
 */
export function reconcileDiscordSubagentThreadBindings(
	isChildSessionLive: (childSessionKey: string) => boolean,
): number {
	const state = getState();
	let dropped = 0;
	for (const [key] of state.byChildSessionKey) {
		let live = false;
		try {
			live = isChildSessionLive(key);
		} catch {
			// On a probe error, keep the binding (fail-open).
			live = true;
		}
		if (!live) {
			state.byChildSessionKey.delete(key);
			dropped += 1;
		}
	}
	return dropped;
}

/** Test-only — wipe the binding registry. */
export function resetDiscordSubagentThreadBindingsForTests(): void {
	getState().byChildSessionKey.clear();
}
