/**
 * Phase 6 — Discord sub-agent thread-binding (Brigade-native materializer).
 *
 * When a sub-agent is spawned with `thread: true` from a Discord conversation,
 * Brigade runs that child in its OWN Discord thread: a fresh thread is created
 * off the originating channel, an intro is posted, the child's session is routed
 * INTO the thread (its key becomes `…:thread:<id>`), the child's completion reply
 * lands in that thread, and a farewell is posted when the child ends.
 *
 * This is the Brigade idiom, NOT the heavier upstream design:
 *   - The binding is held as SESSION metadata (an in-process map keyed by the
 *     child session key) — there is no separate bindings file, no webhook pool,
 *     no ACP runtime, no session-binding adapter registry. Brigade is
 *     sub-agent-only; ACP is permanently dropped.
 *   - Intro + farewell go out via the BOT REST send (the same self-contained
 *     `rest-actions.ts` surface the `discord_action` tool uses) — no webhooks.
 *   - Everything here is gated on the spawn origin being Discord AND
 *     `thread: true`. A non-thread spawn or a non-Discord-origin spawn never
 *     enters this module, so those paths are byte-identical to before.
 *
 * The binding map survives for the process lifetime and is keyed by the child
 * session key so a reload that re-reads the registry can reconcile (drop a
 * binding whose child run no longer exists). It is deliberately lightweight —
 * the central idle-reaper owns thread/session teardown; this module never
 * deletes a thread.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { createSubsystemLogger } from "../../../logging/subsystem-logger.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { resolveDiscordBotToken } from "./account-config.js";
import { sanitizeThreadName } from "./connection.js";
import { sendMessage, threadCreate, type DiscordRestOptions } from "./rest-actions.js";
import {
	getDiscordSubagentThreadBinding,
	rememberDiscordSubagentThreadBinding,
	forgetDiscordSubagentThreadBinding,
} from "./subagent-thread-binding-store.js";
import type { DiscordSubagentThreadBinding } from "./subagent-thread-binding-store.js";

// Re-export the dependency-light store surface so existing imports of the
// registry from this module keep working (the store is split out so hot paths
// can check for a binding without pulling in the Discord REST/connection deps).
export {
	getDiscordSubagentThreadBinding,
	hasDiscordSubagentThreadBinding,
	rememberDiscordSubagentThreadBinding,
	forgetDiscordSubagentThreadBinding,
	listDiscordSubagentThreadBindings,
	reconcileDiscordSubagentThreadBindings,
	resetDiscordSubagentThreadBindingsForTests,
} from "./subagent-thread-binding-store.js";
export type { DiscordSubagentThreadBinding } from "./subagent-thread-binding-store.js";

const log = createSubsystemLogger("agents/channels/discord/subagent-thread-binding");

/**
 * discord.js `ChannelType.PublicThread` (11) — the type a STANDALONE thread is
 * created with via `POST /channels/{id}/threads`. (Type 12 is PRIVATE_THREAD.)
 * A standalone create on a normal text channel must NOT carry a forum-only
 * `message` starter field — that 400s. We create the empty thread, then post the
 * intro as a separate message INTO it.
 */
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;

/** Auto-archive a sub-agent thread after 24h of inactivity (Discord-allowed value). */
const DISCORD_SUBAGENT_THREAD_AUTO_ARCHIVE_MINUTES = 1_440;

/* ───────────────────────── intro / farewell text ───────────────────────── */

/** Intro posted into the freshly-created thread (best-effort, bot send). */
export function buildSubagentThreadIntro(params: { agentId: string; task: string; label?: string }): string {
	const who = params.label?.trim() ? `${params.agentId} ("${params.label.trim()}")` : params.agentId;
	const task = params.task.trim();
	const summary = task.length > 280 ? `${task.slice(0, 277)}…` : task;
	return `🧵 ${who} is on it: ${summary}`;
}

/** Farewell posted into the thread when the child ends (best-effort, bot send). */
export function buildSubagentThreadFarewell(params: {
	agentId: string;
	label?: string;
	outcome?: "ok" | "error" | "timeout" | "abort";
}): string {
	const who = params.label?.trim() ? `${params.agentId} ("${params.label.trim()}")` : params.agentId;
	switch (params.outcome) {
		case "error":
			return `✗ ${who} ended with an error.`;
		case "timeout":
			return `⏱ ${who} timed out.`;
		case "abort":
			return `⊘ ${who} was stopped.`;
		default:
			return `✓ ${who} done.`;
	}
}

/* ───────────────────────── materialization ───────────────────────── */

export interface MaterializeDiscordSubagentThreadParams {
	/** Originating Discord channel id (the spawn's `to` / `conversationId`). */
	parentChannelId: string;
	/** Discord account id (multi-account). */
	accountId?: string;
	/** Base child session key the spawn engine minted (no `:thread:` suffix yet). */
	baseChildSessionKey: string;
	/** Resolved agent id of the child. */
	agentId: string;
	/** The sub-agent task (drives intro text + thread name). */
	task: string;
	/** Optional spawn label. */
	label?: string;
	/** Config accessor — defaults to `readConfigOrInit()`. Injectable for tests. */
	cfg?: BrigadeConfig;
	/** Injectable fetch (tests stub the REST surface). */
	fetchImpl?: typeof fetch;
	/** Injectable token override (tests). Falls back to `resolveDiscordBotToken(cfg)`. */
	botToken?: string;
}

export interface MaterializeDiscordSubagentThreadResult {
	/** The created thread channel id. */
	threadId: string;
	/** The child session key re-rooted into the thread (`…:thread:<id>`). */
	childSessionKey: string;
	/** The binding stored as session metadata. */
	binding: DiscordSubagentThreadBinding;
}

/**
 * Create a Discord thread for a `thread: true` sub-agent, post the intro,
 * re-root the child session into the thread, and stash the binding.
 *
 * Returns `null` (and logs best-effort) when the thread can't be created —
 * the caller falls back to a non-threaded spawn (the child still runs, just in
 * the parent channel's session) so a Discord hiccup never fails the spawn.
 */
export async function materializeDiscordSubagentThread(
	params: MaterializeDiscordSubagentThreadParams,
): Promise<MaterializeDiscordSubagentThreadResult | null> {
	const parentChannelId = params.parentChannelId?.trim();
	if (!parentChannelId) return null;

	let cfg: BrigadeConfig | undefined = params.cfg;
	if (!cfg) {
		try {
			const { readConfigOrInit } = await import("../../../config/io.js");
			cfg = readConfigOrInit();
		} catch (err) {
			log.warn("subagent thread materialize: config load failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	const accountId = params.accountId?.trim() || "default";
	const token = (params.botToken ?? (cfg ? resolveDiscordBotToken(cfg, accountId) : "")).trim();
	if (!token) {
		log.warn("subagent thread materialize: no Discord bot token", { accountId });
		return null;
	}

	const restOpts: DiscordRestOptions = {
		token,
		...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
	};

	const threadName = sanitizeThreadName(
		params.label?.trim() ? `${params.agentId}: ${params.label.trim()}` : `${params.agentId}: ${params.task}`,
		params.baseChildSessionKey,
	);
	const intro = buildSubagentThreadIntro({
		agentId: params.agentId,
		task: params.task,
		...(params.label ? { label: params.label } : {}),
	});

	let threadId = "";
	try {
		// Create a STANDALONE public thread off the text channel. We deliberately
		// DON'T pass a starter `content` — that maps to the forum/media-only
		// `message` field, which Discord 400s on a normal text channel (the bug
		// the verification caught). The intro is posted as a SEPARATE message into
		// the thread below.
		const created = (await threadCreate(
			{
				channelId: parentChannelId,
				name: threadName,
				type: DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
				autoArchiveMinutes: DISCORD_SUBAGENT_THREAD_AUTO_ARCHIVE_MINUTES,
			},
			restOpts,
		)) as { id?: string } | null;
		threadId = typeof created?.id === "string" ? created.id.trim() : "";
	} catch (err) {
		log.warn("subagent thread materialize: threadCreate failed", {
			parentChannelId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (!threadId) {
		log.warn("subagent thread materialize: threadCreate returned no id", { parentChannelId });
		return null;
	}

	// Post the intro as a separate message INTO the newly-created thread (the
	// thread id IS a channel id). Best-effort — a failed intro must not undo a
	// successfully-created thread, so the spawn still binds + runs threaded.
	try {
		await sendMessage({ to: threadId, content: intro }, restOpts);
	} catch (err) {
		log.warn("subagent thread materialize: intro send failed (thread still created)", {
			threadId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Re-root the child session into the thread so its `:thread:<id>` session IS
	// the thread (the central session-reaper handles idle thread sessions).
	const { sessionKey: childSessionKey } = resolveThreadSessionKeys({
		baseSessionKey: params.baseChildSessionKey,
		threadId,
	});

	const binding: DiscordSubagentThreadBinding = {
		childSessionKey,
		threadId,
		parentChannelId,
		accountId,
		agentId: params.agentId,
		...(params.label?.trim() ? { label: params.label.trim() } : {}),
		boundAt: Date.now(),
	};
	rememberDiscordSubagentThreadBinding(binding);

	return { threadId, childSessionKey, binding };
}

/* ───────────────────────── farewell on end ───────────────────────── */

export interface SendDiscordSubagentFarewellParams {
	childSessionKey: string;
	outcome?: "ok" | "error" | "timeout" | "abort";
	cfg?: BrigadeConfig;
	fetchImpl?: typeof fetch;
	botToken?: string;
	/** Drop the binding after sending (default true). */
	forget?: boolean;
}

/**
 * Best-effort farewell into the bound thread when the child ends, then drop the
 * binding (the thread itself is left for the central idle-reaper). No-op when no
 * binding is registered for the child session key.
 */
export async function sendDiscordSubagentThreadFarewell(
	params: SendDiscordSubagentFarewellParams,
): Promise<boolean> {
	const binding = getDiscordSubagentThreadBinding(params.childSessionKey);
	if (!binding) return false;

	const forget = params.forget !== false;
	try {
		let cfg: BrigadeConfig | undefined = params.cfg;
		if (!cfg) {
			const { readConfigOrInit } = await import("../../../config/io.js");
			cfg = readConfigOrInit();
		}
		const token = (params.botToken ?? (cfg ? resolveDiscordBotToken(cfg, binding.accountId) : "")).trim();
		if (!token) {
			log.warn("subagent thread farewell: no Discord bot token", { accountId: binding.accountId });
			return false;
		}
		const text = buildSubagentThreadFarewell({
			agentId: binding.agentId,
			...(binding.label ? { label: binding.label } : {}),
			...(params.outcome ? { outcome: params.outcome } : {}),
		});
		await sendMessage(
			{ to: binding.threadId, content: text },
			{ token, ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}) },
		);
		return true;
	} catch (err) {
		log.warn("subagent thread farewell: send failed", {
			childSessionKey: params.childSessionKey,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	} finally {
		if (forget) forgetDiscordSubagentThreadBinding(params.childSessionKey);
	}
}
