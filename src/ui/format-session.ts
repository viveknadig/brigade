/**
 * Brigade-style human labels for session keys.
 *
 * Session keys are canonical `agent:<id>:<rest>` strings — clear for the
 * routing layer, ugly for an operator skimming the TUI. This module turns
 * the raw key into a short Brigade-friendly chip the connect-mode TUI
 * header, approval prompts, and `/status` overlays can render.
 *
 * Design rules:
 *
 *   - **Home is silent.** The operator's default `:main` session returns
 *     `undefined` so the TUI omits the chip entirely. No `· main` noise
 *     in the 95% common case.
 *   - **Surface the peer.** DMs and groups carry the peer / room id —
 *     the operator needs to know WHO they're chatting with, not just
 *     that it's a "DM".
 *   - **Visual signals.** `↳` precedes sub-agents (nested), `⤳` flags
 *     threads (branches), `⏰` marks cron-triggered turns. Each chip
 *     telegraphs its kind at a glance.
 *   - **Mascot stays exclusive to the brand.** The 🦁 emoji rides only
 *     on the persona name; sub-agents get the "cub" framing without
 *     doubling the lion.
 *
 * Examples:
 *
 *   agent:main:main                            → undefined (omit chip)
 *   agent:ops:main                             → undefined (crew badge carries it)
 *   agent:main:whatsapp:direct:+919876543210   → "WhatsApp · +919876543210"
 *   agent:ops:slack:group:c012abc              → "Slack · c012abc"
 *   agent:work:telegram:channel:@news          → "Telegram · @news"
 *   agent:ops:whatsapp:group:c1:thread:t42     → "WhatsApp · c1 ⤳ t42"
 *   agent:main:subagent:abc-def-uuid           → "↳ cub abc-de…"
 *   agent:main:cron:morning-summary            → "⏰ morning-summary"
 *
 * Casing note: Brigade canonicalises session keys to lowercase at the
 * key-builder layer, so peer ids that were uppercase upstream (e.g. a
 * Slack channel id `C012ABC`) reach this formatter as their lowercase
 * canonical form. We render whatever's in the key — preserving the
 * canonical form is the simplest contract.
 *
 * The agent id is intentionally omitted from the session label — the
 * caller renders it separately as the "crew" badge (e.g. `crew ops`) so
 * the operator sees agent + session as distinct chips, not glued together.
 */

import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

/** Canonical channel id → human label. Anything missing falls back to the raw id title-cased. */
const CHANNEL_LABELS: Record<string, string> = {
	whatsapp: "WhatsApp",
	telegram: "Telegram",
	slack: "Slack",
	discord: "Discord",
	signal: "Signal",
	imessage: "iMessage",
	matrix: "Matrix",
	email: "Email",
	sms: "SMS",
	webhook: "Webhook",
};

/** Max chars before we truncate a peer / room id with an ellipsis. */
const PEER_ID_MAX = 24;
/** Max chars before we truncate a sub-agent uuid. */
const SUBAGENT_ID_MAX = 8;
/** Max chars before we truncate a cron job id. */
const CRON_ID_MAX = 24;
/** Max chars before we truncate a thread id. */
const THREAD_ID_MAX = 12;

function titleCase(raw: string): string {
	if (!raw) return raw;
	return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function humanChannel(channelId: string): string {
	const lowered = channelId.toLowerCase();
	return CHANNEL_LABELS[lowered] ?? titleCase(channelId);
}

function shortenId(id: string, max: number): string {
	if (!id) return id;
	if (id.length <= max) return id;
	return `${id.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Convert a raw session key to a Brigade-friendly chip — or `undefined`
 * if the chip should be omitted (the default `:main` home session, or an
 * empty / unparseable key).
 *
 * Callers should treat `undefined` as "render nothing here" so the
 * header stays clean in the common case.
 */
export function formatSessionLabel(sessionKey: string | undefined | null): string | undefined {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return undefined;
	const parsed = parseAgentSessionKey(raw);
	if (!parsed) return raw;
	const rest = parsed.rest.trim();
	// Home / main session → omit the chip entirely. The crew badge
	// already tells the operator which agent's home they're in.
	if (!rest || rest === "main") return undefined;

	// Strip an optional :thread:<id> suffix BEFORE further parsing so the
	// thread tag never confuses the channel/peerKind split below. The
	// curved arrow `⤳` reads as "branch into" — picks out the thread
	// inline without spelling out the word.
	let threadSuffix = "";
	let body = rest;
	const threadIdx = body.lastIndexOf(":thread:");
	if (threadIdx >= 0) {
		const threadId = body.slice(threadIdx + ":thread:".length);
		threadSuffix = ` ⤳ ${shortenId(threadId, THREAD_ID_MAX)}`;
		body = body.slice(0, threadIdx);
	}

	// Sub-agent: `subagent:<uuid>` — Brigade's brand framing calls
	// nested agents "cubs" (part of the Pride). The `↳` arrow telegraphs
	// "this is a child of the parent agent" without re-using the 🦁
	// mascot that already rides the persona label.
	if (body.startsWith("subagent:")) {
		const id = body.slice("subagent:".length).split(":")[0] ?? "";
		return `↳ cub ${shortenId(id, SUBAGENT_ID_MAX)}${threadSuffix}`;
	}

	// Cron: `cron:<jobId>` — clock emoji is universal; drop the literal
	// "cron · " prefix in favour of just the job id.
	if (body.startsWith("cron:")) {
		const jobId = body.slice("cron:".length).split(":")[0] ?? "";
		return `⏰ ${shortenId(jobId, CRON_ID_MAX)}${threadSuffix}`;
	}

	const parts = body.split(":");
	if (parts.length === 1) {
		// Single token after agent id — likely a custom alias. Keep as-is.
		return `${parts[0]}${threadSuffix}`;
	}

	// Channel-routed: `<channel>:<peerKind>:<peerId>` OR
	// `<channel>:<accountId>:<peerKind>:<peerId>`. The peer id is the
	// operator-recognisable bit (phone number, @handle, Slack channel id)
	// so we surface it; the peer KIND (direct / group / channel) is
	// implicit from the channel + peer id format and we drop it.
	const channel = parts[0] ?? "";
	const second = parts[1] ?? "";
	const peerKindCandidates = new Set(["direct", "group", "channel"]);
	const isPeerKindAtSecond = peerKindCandidates.has(second.toLowerCase());
	let peerId = "";
	if (isPeerKindAtSecond) {
		peerId = parts.slice(2).join(":");
	} else if (parts.length >= 3 && peerKindCandidates.has((parts[2] ?? "").toLowerCase())) {
		// Per-account-channel-peer shape: <channel>:<account>:<peerKind>:<peerId>
		peerId = parts.slice(3).join(":");
	}
	const channelLabel = channel ? humanChannel(channel) : "";
	const peerLabel = peerId ? shortenId(peerId, PEER_ID_MAX) : "";
	if (channelLabel && peerLabel) {
		return `${channelLabel} · ${peerLabel}${threadSuffix}`;
	}
	if (channelLabel) {
		return `${channelLabel}${threadSuffix}`;
	}
	// Fallback — return the rest verbatim so we never lose information.
	return `${rest}`;
}

/**
 * Compose a Brigade-style "crew" badge for the agent id. Returns the
 * empty string when there's nothing useful to show (caller skips the
 * segment in that case).
 *
 *   - default agent (`"main"`) WITH a persona name set → "" (the persona
 *     name is enough; we don't double-label).
 *   - default agent without persona name                → "crew main"
 *   - non-default agent                                 → "crew ops"
 */
export function formatCrewLabel(params: {
	agentId: string | undefined | null;
	personaName?: string | undefined | null;
}): string {
	const id = (params.agentId ?? "").trim();
	if (!id) return "";
	const hasPersona = !!params.personaName?.trim();
	if (id === "main" && hasPersona) return "";
	return `crew ${id}`;
}
