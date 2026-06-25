/**
 * iMessage target parsing + handle normalisation.
 *
 * An iMessage send can address four kinds of target, distinguished by a leading
 * prefix (case-insensitive):
 *
 *   - `handle`          a phone number (`+15551234567`) or email
 *                       (`user@example.com`), optionally service-prefixed
 *                       (`imessage:`, `sms:`, `auto:`).
 *   - `chat_id`         a numeric SQLite thread id      (`chat_id:42`, `chat:42`).
 *   - `chat_guid`       a stable thread GUID            (`chat_guid:ABC-…`).
 *   - `chat_identifier` a thread identifier             (`chat_identifier:…`).
 *
 * `parseIMessageTarget` (the SEND path) is STRICT — it throws on a malformed
 * `chat_id`. `parseIMessageAllowTarget` (the ALLOW-LIST path) is LENIENT — it
 * skips a malformed prefix rather than throwing. `normalizeIMessageHandle`
 * canonicalises a handle (lowercase email, E.164 phone, chat prefixes preserved)
 * so inbound senders and allow-list entries compare consistently.
 *
 * Condensed from the upstream `targets.ts` + `target-parsing-helpers.ts` +
 * `normalize.ts` trio into one self-contained module (the brand-neutral
 * chat-target-prefix engine lived in a shared SDK file there).
 */

import type { IMessageService } from "./account-config.js";

/** A parsed outbound target. */
export type IMessageTarget =
	| { kind: "chat_id"; chatId: number }
	| { kind: "chat_guid"; chatGuid: string }
	| { kind: "chat_identifier"; chatIdentifier: string }
	| { kind: "handle"; to: string; service: IMessageService };

/** A parsed allow-list target (lenient — a bare handle string is the fallback). */
export type IMessageAllowTarget =
	| { kind: "chat_id"; chatId: number }
	| { kind: "chat_guid"; chatGuid: string }
	| { kind: "chat_identifier"; chatIdentifier: string }
	| { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"] as const;
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"] as const;
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"] as const;
const SERVICE_PREFIXES: ReadonlyArray<{ prefix: string; service: IMessageService }> = [
	{ prefix: "imessage:", service: "imessage" },
	{ prefix: "sms:", service: "sms" },
	{ prefix: "auto:", service: "auto" },
];

const CHAT_TARGET_PREFIX_RE =
	/^(chat_id:|chatid:|chat:|chat_guid:|chatguid:|guid:|chat_identifier:|chatidentifier:|chatident:)/i;
const SERVICE_PREFIX_RE = /^(imessage:|sms:|auto:)/i;

function stripPrefix(value: string, prefix: string): string {
	return value.slice(prefix.length).trim();
}

/**
 * Normalise a phone-ish string to E.164. Strips a leading `scheme:`, removes
 * everything but digits and `+`, and prepends `+` when missing.
 */
export function normalizeE164(raw: string): string {
	let v = raw.trim().replace(/^[a-z][a-z0-9-]*:/i, "");
	v = v.replace(/[^0-9+]/g, "");
	if (!v) return "";
	if (v.startsWith("+")) return `+${v.slice(1).replace(/\+/g, "")}`;
	return `+${v.replace(/\+/g, "")}`;
}

/**
 * Canonicalise an iMessage handle for comparison. Service prefixes are stripped
 * (and re-applied by callers that care); chat prefixes are lowercased on the
 * prefix only; an email lowercases whole; a phone becomes E.164; anything else
 * has its whitespace stripped.
 */
export function normalizeIMessageHandle(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const lower = trimmed.toLowerCase();
	// Strip a service prefix and recurse on the remainder.
	for (const { prefix } of SERVICE_PREFIXES) {
		if (lower.startsWith(prefix)) return normalizeIMessageHandle(trimmed.slice(prefix.length));
	}
	// Chat prefixes — lowercase the prefix, keep the value's case.
	for (const prefix of [...CHAT_ID_PREFIXES, ...CHAT_GUID_PREFIXES, ...CHAT_IDENTIFIER_PREFIXES]) {
		if (lower.startsWith(prefix)) {
			const value = trimmed.slice(prefix.length).trim();
			return `${prefix}${value}`;
		}
	}
	if (trimmed.includes("@")) return lower; // email handle
	const e164 = normalizeE164(trimmed);
	if (e164) return e164;
	return trimmed.replace(/\s+/g, "");
}

/** Strict chat-prefix parse — throws on a malformed `chat_id`. Returns null when no chat prefix matched. */
function parseChatTargetStrict(trimmed: string, lower: string): IMessageTarget | null {
	for (const prefix of CHAT_ID_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const value = stripPrefix(trimmed, prefix);
			const chatId = Number.parseInt(value, 10);
			if (!Number.isFinite(chatId)) throw new Error(`Invalid chat_id: ${value}`);
			return { kind: "chat_id", chatId };
		}
	}
	for (const prefix of CHAT_GUID_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const value = stripPrefix(trimmed, prefix);
			if (!value) throw new Error("chat_guid is required");
			return { kind: "chat_guid", chatGuid: value };
		}
	}
	for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const value = stripPrefix(trimmed, prefix);
			if (!value) throw new Error("chat_identifier is required");
			return { kind: "chat_identifier", chatIdentifier: value };
		}
	}
	return null;
}

/** Lenient chat-prefix parse — skips a malformed prefix (returns null). */
function parseChatTargetLenient(trimmed: string, lower: string): IMessageAllowTarget | null {
	for (const prefix of CHAT_ID_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const chatId = Number.parseInt(stripPrefix(trimmed, prefix), 10);
			if (!Number.isFinite(chatId)) return null;
			return { kind: "chat_id", chatId };
		}
	}
	for (const prefix of CHAT_GUID_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const value = stripPrefix(trimmed, prefix);
			return value ? { kind: "chat_guid", chatGuid: value } : null;
		}
	}
	for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const value = stripPrefix(trimmed, prefix);
			return value ? { kind: "chat_identifier", chatIdentifier: value } : null;
		}
	}
	return null;
}

/**
 * Parse an outbound target (SEND path). Throws when the target is empty or a
 * chat prefix is malformed. A service-prefixed handle keeps its service; a bare
 * handle defaults to `auto`.
 */
export function parseIMessageTarget(raw: string): IMessageTarget {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) throw new Error("iMessage target is required");
	const lower = trimmed.toLowerCase();
	// Service-prefixed: strip it, then either parse a chat target or a bare handle.
	for (const { prefix, service } of SERVICE_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const remainder = stripPrefix(trimmed, prefix);
			if (!remainder) throw new Error(`${prefix} target is required`);
			const chat = parseChatTargetStrict(remainder, remainder.toLowerCase());
			if (chat) return chat;
			return { kind: "handle", to: remainder, service };
		}
	}
	const chat = parseChatTargetStrict(trimmed, lower);
	if (chat) return chat;
	return { kind: "handle", to: trimmed, service: "auto" };
}

/** Parse an allow-list target (LENIENT). A bare/unparseable string is a normalized handle. */
export function parseIMessageAllowTarget(raw: string): IMessageAllowTarget {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { kind: "handle", handle: "" };
	const lower = trimmed.toLowerCase();
	for (const { prefix } of SERVICE_PREFIXES) {
		if (lower.startsWith(prefix)) {
			const remainder = stripPrefix(trimmed, prefix);
			if (!remainder) return { kind: "handle", handle: "" };
			const chat = parseChatTargetLenient(remainder, remainder.toLowerCase());
			if (chat) return chat;
			return { kind: "handle", handle: normalizeIMessageHandle(remainder) };
		}
	}
	const chat = parseChatTargetLenient(trimmed, lower);
	if (chat) return chat;
	return { kind: "handle", handle: normalizeIMessageHandle(trimmed) };
}

/** Format a numeric chat id into the canonical `chat_id:N` target form. */
export function formatIMessageChatTarget(chatId?: number): string {
	if (chatId === undefined || chatId === null || !Number.isFinite(chatId)) return "";
	return `chat_id:${chatId}`;
}

/** True iff a string carries an explicit chat / service prefix (vs a bare name). */
export function looksLikeIMessageTargetId(raw: string): boolean {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return false;
	if (CHAT_TARGET_PREFIX_RE.test(trimmed)) return true;
	if (SERVICE_PREFIX_RE.test(trimmed)) return true;
	if (trimmed.includes("@")) return true;
	return /^\+?\d{3,}$/.test(trimmed);
}

/** Advisory chat-type guess from a (parsed) target — never throws. */
export function inferIMessageTargetChatType(raw: string): "dm" | "group" | undefined {
	try {
		const t = parseIMessageTarget(raw);
		return t.kind === "handle" ? "dm" : "group";
	} catch {
		return undefined;
	}
}

/**
 * Decide whether a (normalized) inbound sender is allowed given a list of
 * allow-from entries. `*` is a wildcard. Returns false on an empty list.
 */
export function isAllowedIMessageSender(params: {
	allowFrom: ReadonlyArray<string | number>;
	sender: string;
	chatId?: number;
	chatGuid?: string;
	chatIdentifier?: string;
}): boolean {
	const entries = params.allowFrom.map((e) => String(e).trim()).filter(Boolean);
	if (entries.length === 0) return false;
	if (entries.includes("*")) return true;
	const senderNorm = normalizeIMessageHandle(params.sender);
	for (const entry of entries) {
		const target = parseIMessageAllowTarget(entry);
		switch (target.kind) {
			case "chat_id":
				if (params.chatId !== undefined && target.chatId === params.chatId) return true;
				break;
			case "chat_guid":
				if (params.chatGuid && target.chatGuid === params.chatGuid) return true;
				break;
			case "chat_identifier":
				if (params.chatIdentifier && target.chatIdentifier === params.chatIdentifier) return true;
				break;
			case "handle":
				if (target.handle && target.handle === senderNorm) return true;
				break;
		}
	}
	return false;
}
