/**
 * `brigade pairing …` — approve/revoke pending pairing codes.
 *
 * When `channels.<id>.dmPolicy` is `pairing` (the default), a stranger DMing
 * the bot gets an 8-char code in the reply and asks the operator to approve
 * it. The operator runs `brigade pairing approve <CODE>` here, which moves
 * the sender from "pending" to the channel's allow-from list — subsequent DMs
 * from that sender reach the agent.
 *
 * Channel resolution mirrors `brigade channels …` (auto-pick when only one
 * channel is available).
 */

import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import type { ChannelAdapter } from "../../agents/extensions/types.js";
import {
	approvePairingCode,
	readChannelOwner,
	readPendingPairings,
	revokePairingCode,
	setChannelOwner,
} from "../../agents/channels/access-control/index.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";

/**
 * Test injection hook — overrides the channel registry so unit tests can
 * drive `pairing approve` against a fake adapter (with a spy `notifyApproval`)
 * without depending on bundled modules. Production callers leave this
 * `undefined`; tests set it in `beforeEach` and clear it in `afterEach`.
 */
let testChannelOverride: ChannelAdapter[] | undefined;

/** @internal — tests only. */
export function __setPairingChannelsForTests(channels: ChannelAdapter[] | undefined): void {
	testChannelOverride = channels;
}

/**
 * Resolve the channel id; either auto-picked (single channel) or named.
 * Also returns the adapter so callers that need to invoke per-channel
 * pairing hooks (`notifyApproval`) don't have to re-load the module
 * registry a second time.
 */
async function resolveChannel(
	wanted: string | undefined,
): Promise<{ id: string; adapter: ChannelAdapter } | { error: number }> {
	let adapters: ChannelAdapter[];
	if (testChannelOverride) {
		adapters = testChannelOverride;
	} else {
		const config = loadConfig();
		const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
		const registry = await loadModules({
			modules: BUNDLED_MODULES,
			meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
		});
		adapters = registry.channels;
	}
	if (adapters.length === 0) {
		process.stderr.write("No channels are bundled or installed.\n");
		return { error: 2 };
	}
	if (wanted) {
		const found = adapters.find((c) => c.id === wanted);
		if (!found) {
			process.stderr.write(`Unknown channel "${wanted}" (have: ${adapters.map((c) => c.id).join(", ")}).\n`);
			return { error: 2 };
		}
		return { id: found.id, adapter: found };
	}
	if (adapters.length === 1) {
		const sole = adapters[0] as ChannelAdapter;
		return { id: sole.id, adapter: sole };
	}
	process.stderr.write(
		`More than one channel is available — pick one with --channel <id> (have: ${adapters.map((c) => c.id).join(", ")}).\n`,
	);
	return { error: 2 };
}

/** Back-compat helper for existing call sites that only need the id. */
async function resolveChannelId(wanted: string | undefined): Promise<{ id: string } | { error: number }> {
	const r = await resolveChannel(wanted);
	if ("error" in r) return { error: r.error };
	return { id: r.id };
}

/* ─────────────────────────── pairing list ─────────────────────────── */

export async function runPairingList(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannelId(args.channel);
	if ("error" in resolved) return resolved.error;
	const pending = readPendingPairings(resolved.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channel: resolved.id, pending }, null, 2)}\n`);
		return 0;
	}
	if (pending.length === 0) {
		process.stdout.write(`No pending pairing codes for ${resolved.id}.\n`);
		return 0;
	}
	const header = `${"CODE".padEnd(10)} ${"SENDER".padEnd(28)} ${"NAME".padEnd(20)} CREATED`;
	process.stdout.write(`${header}\n`);
	for (const r of pending) {
		const line = `${r.code.padEnd(10)} ${r.senderId.padEnd(28)} ${(r.senderName ?? "—").padEnd(20)} ${r.createdAt}`;
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

/* ─────────────────────────── pairing approve ─────────────────────────── */

export async function runPairingApprove(
	args: { code: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannel(args.channel);
	if ("error" in resolved) return resolved.error;
	const approved = approvePairingCode(resolved.id, args.code);
	if (!approved) {
		const msg = `Unknown or expired pairing code for ${resolved.id}.`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	// Owner bootstrap. On a channel whose bot account is SEPARATE from the
	// operator (Telegram: `selfId()` is the bot, never the human), the FIRST
	// approved sender becomes the recorded owner — so owner-only commands and the
	// skip-challenge path work for them. Running `pairing approve` requires
	// gateway-machine access, which IS the proof that this is the operator (a
	// stranger who merely texts the bot can never reach here). Never overwrites an
	// existing owner.
	let becameOwner = false;
	if (resolved.adapter.pairing?.botIsSeparateFromOperator && !readChannelOwner(resolved.id)) {
		becameOwner = setChannelOwner(resolved.id, approved.senderId);
	}
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, channel: resolved.id, sender: approved.senderId, owner: becameOwner }, null, 2)}\n`,
		);
	} else {
		const who = approved.senderName ? `${approved.senderName} (${approved.senderId})` : approved.senderId;
		process.stdout.write(`Approved ${who} on ${resolved.id}. They can now DM the agent.\n`);
		if (becameOwner) {
			process.stdout.write(
				`Set ${who} as the OWNER of ${resolved.id} — they can now run admin commands (/pending, /approve, /allowlist) from the chat.\n`,
			);
		}
	}
	// Best-effort in-channel confirmation — when the channel adapter declares
	// a `pairing.notifyApproval` hook, fire it so the requester sees a
	// "you're approved" reply in-channel. Failures here are non-fatal: the
	// approval already landed in the on-disk allow-list, the operator
	// already saw the CLI confirmation. WhatsApp currently omits this
	// hook (no slot wired); Slack/Discord channels will fill it in.
	const notify = resolved.adapter.pairing?.notifyApproval;
	if (notify) {
		try {
			await notify({ senderId: approved.senderId, senderName: approved.senderName });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`Warning: failed to notify approved sender in-channel (${msg}).\n`);
		}
	}
	return 0;
}

/* ─────────────────────────── pairing revoke ─────────────────────────── */

export async function runPairingRevoke(
	args: { code: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const resolved = await resolveChannelId(args.channel);
	if ("error" in resolved) return resolved.error;
	const dropped = revokePairingCode(resolved.id, args.code);
	if (!dropped) {
		const msg = `No matching pending code on ${resolved.id}.`;
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, channel: resolved.id })}\n`);
	else process.stdout.write(`Pending code revoked on ${resolved.id}.\n`);
	return 0;
}
