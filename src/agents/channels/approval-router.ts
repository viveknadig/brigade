/**
 * Channel approval router — bridges Brigade's per-turn exec-gate to channel
 * adapters so an approval prompt raised by a channel-routed turn lands IN
 * the same conversation, not on the gateway WebSocket where nobody is
 * watching.
 *
 * Why this exists. Connect-mode TUI works because the operator is sitting
 * at the WebSocket consumer. Channel-routed turns (WhatsApp / Slack /
 * Discord DMs into Brigade) raise the same approval prompts through the
 * same bridge — but the operator is on their phone, not in the TUI. The
 * default path broadcasts on WS and hangs for the full 5-minute timeout.
 * This module re-routes those prompts back to the channel: send the prompt
 * as an outbound message, intercept the next inbound from the same peer
 * for a yes/no answer, resolve the bridge with the matching decision.
 *
 * Wiring at boot (in `startChannels`):
 *
 *   for each adapter:
 *     registerChannelApprovalDispatcher(adapter.id, {
 *       sendText: adapter.sendText,
 *       prettyName: adapter.label,
 *     });
 *
 * On every channel inbound, BEFORE the normal turn-dispatch path:
 *
 *   if (tryConsumeChannelApprovalReply({channelId, conversationId, text})) {
 *     return; // handled — bridge resolved, prompt acknowledged
 *   }
 *
 * On every channel-routed turn, the inbound carries an `ChannelApprovalRoute`
 * through `runGatewayTurn` → `runResilientTurn` → `runSingleTurn` →
 * `gateCtxRef.value.channelRoute`. The exec-gate then includes that route on
 * its `bridge.requestApproval(...)` call, and `InMemoryApprovalBridge.requestApproval`
 * — when it sees the route — calls `dispatchChannelApproval(...)` to send
 * the prompt as outbound text instead of (well, in addition to) the WS
 * broadcast.
 *
 * Process-wide singleton because there is exactly one channel manager per
 * gateway process and the exec-gate / approval-bridge live module-level —
 * threading a registry through 8 layers of args is the same fight as
 * the bridge itself (see `approval-bridge.ts` for the same rationale).
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { ApprovalDecision, ApprovalDecisionKind, ApprovalRequest } from "../approval-bridge.js";

const log = createSubsystemLogger("brigade/channel-approvals");

/** A pending approval the channel router is waiting on a yes/no for. */
export interface ChannelApprovalRoute {
	channelId: string;
	conversationId: string;
	threadId?: string;
	/** Channel-specific account id when the channel supports multi-account. */
	accountId?: string;
}

/**
 * Per-adapter dispatcher capability surface — minimal, exactly the bits
 * `dispatchChannelApproval` needs to ask the operator and the bits that
 * make the log lines useful. The channel manager constructs these at
 * `startChannels` boot from each adapter's outbound surface.
 */
export interface ChannelApprovalDispatcher {
	/** Send the approval prompt to the conversation. */
	sendText: (
		conversationId: string,
		text: string,
		opts?: { threadId?: string },
	) => Promise<void>;
	/** Human-readable label for log lines + the prompt header (e.g. "WhatsApp"). */
	prettyName: string;
}

/** Entry stored per pending approval. The router owns the lifecycle. */
interface PendingChannelApproval {
	request: ApprovalRequest;
	route: ChannelApprovalRoute;
	/** Called by `tryConsumeChannelApprovalReply` to settle the bridge. */
	resolveOnBridge: (decision: ApprovalDecision) => void;
	/** Per-pending watchdog that cleans up the slot if the operator goes silent. */
	timer: ReturnType<typeof setTimeout>;
	createdAtMs: number;
}

const dispatchers = new Map<string, ChannelApprovalDispatcher>();
/** Keyed by `${channelId}::${conversationId}` — only one pending per peer at a time. */
const pendingByPeer = new Map<string, PendingChannelApproval>();
/** Keyed by approval-request id — for `cancelChannelApprovalById` cleanup. */
const pendingById = new Map<string, PendingChannelApproval>();

function peerKey(channelId: string, conversationId: string): string {
	return `${channelId}::${conversationId}`;
}

/**
 * Register an adapter's outbound surface so the bridge can route prompts
 * through it. Called by `startChannels` for every adapter that started
 * successfully. Idempotent — re-registering replaces the previous entry
 * (channel hot-reload friendly).
 */
export function registerChannelApprovalDispatcher(
	channelId: string,
	dispatcher: ChannelApprovalDispatcher,
): void {
	dispatchers.set(channelId, dispatcher);
}

/**
 * Drop a channel's dispatcher. Channel manager's `stop()` calls this for
 * every started adapter so a torn-down WhatsApp can't be asked to send
 * messages after the socket is gone.
 */
export function removeChannelApprovalDispatcher(channelId: string): void {
	dispatchers.delete(channelId);
	// Also reject any in-flight prompts the channel was carrying — the
	// operator can't reply through a torn-down adapter, so we deny rather
	// than leak.
	for (const [key, entry] of pendingByPeer.entries()) {
		if (entry.route.channelId !== channelId) continue;
		clearTimeout(entry.timer);
		pendingByPeer.delete(key);
		pendingById.delete(entry.request.id);
		entry.resolveOnBridge({ kind: "deny", timedOut: true });
	}
}

/** Diagnostic — used by tests + gateway `/health` checks. */
export function listChannelApprovalDispatchers(): string[] {
	return [...dispatchers.keys()];
}

/** Diagnostic — pending entries snapshot (returns shallow clones). */
export function listPendingChannelApprovals(): Array<{
	id: string;
	channelId: string;
	conversationId: string;
	command: string;
	ageMs: number;
}> {
	const now = Date.now();
	return [...pendingByPeer.values()].map((p) => ({
		id: p.request.id,
		channelId: p.route.channelId,
		conversationId: p.route.conversationId,
		command: p.request.command,
		ageMs: now - p.createdAtMs,
	}));
}

/**
 * Build the human-readable approval prompt the operator sees in the
 * channel. Kept short because some channels (Telegram captions, WhatsApp
 * note-cards) impose length limits — the model's command preview is the
 * informative part; the reply menu is the operator's actionable line.
 *
 * The 🦁 mark is the Brigade mascot — same brand-stamp used elsewhere in
 * channel surfaces so the operator recognises this as a Brigade prompt and
 * not an arbitrary chat partner asking for shell access.
 */
function buildPromptText(args: {
	command: string;
	subagentLabel?: string;
}): string {
	const flat = args.command
		.replace(/[\r\n]+/g, " ")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const preview = flat.length <= 180 ? flat : `${flat.slice(0, 177)}…`;
	const who = args.subagentLabel
		? `Sub-agent "${args.subagentLabel}"`
		: "🦁 Brigade";
	return [
		`${who} wants to run a shell command:`,
		`\`${preview}\``,
		"",
		"Reply *yes* to allow this once,",
		"*always* to allowlist this exact command,",
		"or *no* to deny.",
		"",
		"Times out in 5 minutes.",
	].join("\n");
}

/**
 * Decode an operator's text reply into a decision kind. Liberal in what
 * it accepts so the operator can type the obvious shapes without thinking:
 *   yes / y / ok / allow / sure  → allow-once
 *   always / save / remember     → allow-always
 *   no / n / deny / cancel / nah → deny
 *
 * `null` means "couldn't decide — fall through to normal turn dispatch."
 * That lets the operator change the subject mid-prompt (a fresh question
 * they typed in the same chat) rather than have it eaten by the gate.
 */
function decodeReply(text: string): ApprovalDecisionKind | null {
	const t = text.trim().toLowerCase();
	if (!t) return null;
	// Strip leading "/" so "/yes" works too — operators with slash-command
	// muscle memory from Slack/Telegram won't be surprised.
	const stripped = t.startsWith("/") ? t.slice(1) : t;
	const first = stripped.split(/\s+/, 1)[0] ?? stripped;
	switch (first) {
		case "yes":
		case "y":
		case "ok":
		case "okay":
		case "sure":
		case "allow":
		case "approve":
		case "approved":
			return "allow-once";
		case "always":
		case "save":
		case "remember":
		case "allow-always":
		case "allowalways":
			return "allow-always";
		case "no":
		case "n":
		case "nope":
		case "nah":
		case "deny":
		case "denied":
		case "cancel":
		case "stop":
		case "reject":
			return "deny";
		default:
			return null;
	}
}

/**
 * Send the approval prompt via the channel and register a pending entry
 * the next inbound from the same peer will consume.
 *
 * Returns:
 *   - `true`  → prompt dispatched, channel route owns this approval; the
 *               bridge MUST wait for `tryConsumeChannelApprovalReply` (or
 *               its watchdog timeout) to settle.
 *   - `false` → no dispatcher registered for `channelId`, or `sendText`
 *               threw. Caller (the approval-bridge) falls back to the
 *               default WS-broadcast path so the prompt still goes
 *               somewhere instead of vanishing.
 */
export async function dispatchChannelApproval(args: {
	request: ApprovalRequest;
	route: ChannelApprovalRoute;
	resolveOnBridge: (decision: ApprovalDecision) => void;
}): Promise<boolean> {
	const { request, route, resolveOnBridge } = args;
	const dispatcher = dispatchers.get(route.channelId);
	if (!dispatcher) {
		log.warn("no dispatcher for channel — falling back to WS broadcast", {
			channelId: route.channelId,
			conversationId: route.conversationId,
		});
		return false;
	}
	const key = peerKey(route.channelId, route.conversationId);
	// If there's already a pending entry for this peer, deny the previous
	// one. A second prompt overlapping the same peer means we'd be asking
	// two questions at once — the operator can only answer one, the other
	// would hang. Deny-the-older is the safer disposition: the model that
	// raised the older prompt gets a clean "no" and can ask again, rather
	// than a stale "deny on timeout" five minutes later.
	const existing = pendingByPeer.get(key);
	if (existing) {
		clearTimeout(existing.timer);
		pendingByPeer.delete(key);
		pendingById.delete(existing.request.id);
		existing.resolveOnBridge({ kind: "deny", timedOut: false });
	}
	const prompt = buildPromptText({
		command: request.command,
		...(request.subagentLabel !== undefined ? { subagentLabel: request.subagentLabel } : {}),
	});
	try {
		const sendOpts = route.threadId ? { threadId: route.threadId } : undefined;
		await dispatcher.sendText(route.conversationId, prompt, sendOpts);
	} catch (err) {
		log.warn("approval prompt send failed — falling back to WS broadcast", {
			channelId: route.channelId,
			conversationId: route.conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
	// Internal watchdog independent of the bridge's own timeout: the bridge
	// timer fires at `request.timeoutMs` and resolves the in-flight promise;
	// when that happens we still need to clean OUR maps so a late operator
	// reply doesn't intercept the next turn's text by mistake. We run a
	// matching timer at the same horizon — whichever fires first wins, and
	// the loser is a no-op because the entry is already gone.
	const watchdog = setTimeout(() => {
		const entry = pendingByPeer.get(key);
		if (!entry || entry.request.id !== request.id) return;
		pendingByPeer.delete(key);
		pendingById.delete(request.id);
		// The bridge will fire its own timeout at the same moment; we don't
		// need to call `resolveOnBridge` here because the bridge's timer
		// already does. Setting our entry aside is enough.
	}, request.timeoutMs);
	if (typeof watchdog.unref === "function") watchdog.unref();
	const entry: PendingChannelApproval = {
		request,
		route,
		resolveOnBridge,
		timer: watchdog,
		createdAtMs: Date.now(),
	};
	pendingByPeer.set(key, entry);
	pendingById.set(request.id, entry);
	log.info("approval prompt sent via channel", {
		channelId: route.channelId,
		conversationId: route.conversationId,
		approvalId: request.id,
		via: dispatcher.prettyName,
	});
	return true;
}

/**
 * Try to consume `text` as a yes/no reply to a pending approval for this
 * peer. Returns:
 *   - `true`  → text WAS a yes/no answer + bridge has been resolved; the
 *               caller (channel inbound handler) should `return` and NOT
 *               dispatch a turn for this message.
 *   - `false` → no pending approval for this peer, OR text wasn't a
 *               yes/no shape. Caller proceeds with normal dispatch.
 *
 * Notes for the channel inbound:
 *   - Must be called AFTER the access-policy check (we only intercept
 *     trusted peers — strangers can't accidentally answer an approval).
 *   - Must be called BEFORE the abort-trigger check (the abort word "stop"
 *     overlaps the "no" vocabulary; pending-approval intent wins).
 *   - The channel adapter's `sendText` for the acknowledgement is the
 *     caller's responsibility — the router only does the bridge plumbing.
 *     This keeps the router test-friendly (no I/O side effects on the
 *     intercept path) and lets per-channel formatting differ.
 */
export function tryConsumeChannelApprovalReply(args: {
	channelId: string;
	conversationId: string;
	text: string;
}): { matched: true; decision: ApprovalDecisionKind; approvalId: string } | { matched: false } {
	const key = peerKey(args.channelId, args.conversationId);
	const entry = pendingByPeer.get(key);
	if (!entry) return { matched: false };
	const kind = decodeReply(args.text);
	if (kind === null) return { matched: false };
	pendingByPeer.delete(key);
	pendingById.delete(entry.request.id);
	clearTimeout(entry.timer);
	const decision: ApprovalDecision = { kind };
	entry.resolveOnBridge(decision);
	log.info("approval resolved via channel reply", {
		channelId: args.channelId,
		conversationId: args.conversationId,
		approvalId: entry.request.id,
		decision: kind,
	});
	return { matched: true, decision: kind, approvalId: entry.request.id };
}

/**
 * Cancel a pending approval by request id (e.g. on session abort).
 * Bridge already cleans its own maps; this clears ours so a late reply
 * doesn't get mis-routed to a different turn.
 */
export function cancelChannelApprovalById(approvalId: string): void {
	const entry = pendingById.get(approvalId);
	if (!entry) return;
	const key = peerKey(entry.route.channelId, entry.route.conversationId);
	clearTimeout(entry.timer);
	pendingByPeer.delete(key);
	pendingById.delete(approvalId);
}

/** Test-only — clear every registration + pending entry. */
export function resetChannelApprovalRouterForTests(): void {
	for (const entry of pendingByPeer.values()) clearTimeout(entry.timer);
	pendingByPeer.clear();
	pendingById.clear();
	dispatchers.clear();
}
