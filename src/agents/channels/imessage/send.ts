/**
 * iMessage outbound send — assemble + dispatch a `send` RPC.
 *
 * `sendMessageIMessage` parses the target (handle / chat_id / chat_guid /
 * chat_identifier), converts markdown tables to plain text, resolves an optional
 * media attachment to a local path (through the exfil guard), sanitizes a
 * reply-to id, and writes the `send` JSON-RPC call. When the message has media
 * but no text it delivers a `<media:kind>` placeholder so the echo cache + the
 * transcript have a body.
 *
 * The RPC client is INJECTABLE (`opts.client`) — that is the test seam: a unit
 * test passes a fake {@link IMessageRpcLike} and exercises every target kind +
 * media + reply with NO real `imsg` binary. A client WE created here is stopped
 * in the `finally`; an injected one is left for the caller to own.
 */

import {
	createIMessageRpcClient,
	type IMessageRpcLike,
} from "./client.js";
import {
	markdownToIMessageText,
	resolveDeliveredText,
	sanitizeReplyToId,
	type IMessageMediaKind,
} from "./format.js";
import { resolveOutboundAttachment } from "./media.js";
import { formatIMessageChatTarget, parseIMessageTarget } from "./targets.js";
import type { IMessageService } from "./account-config.js";

/** Options for {@link sendMessageIMessage}. */
export interface IMessageSendOpts {
	/** `imsg` binary path (only used when constructing a client ourselves). */
	cliPath?: string;
	/** Optional chat.db override. */
	dbPath?: string;
	/** Default send service when the target doesn't pin one (`auto`). */
	service?: IMessageService;
	/** Phone-number region for E.164 normalisation (default `US`). */
	region?: string;
	/** Native reply-to message id (sanitized before send). */
	replyToId?: string;
	/** Local media path to attach (validated through the exfil guard). */
	mediaPath?: string;
	/** Pre-inferred media kind for the `<media:kind>` placeholder (else inferred). */
	mediaKind?: IMessageMediaKind;
	/** Outbound media size cap (bytes). */
	maxBytes?: number;
	/** RPC timeout (ms). */
	timeoutMs?: number;
	/** Force a numeric chat-id target (wins over `to`). */
	chatId?: number;
	/** Inject a live RPC client (the test seam). When set, it is NOT stopped here. */
	client?: IMessageRpcLike;
	/** Inject a client factory (production default constructs the real one). */
	createClient?: (args: { cliPath?: string; dbPath?: string }) => Promise<IMessageRpcLike>;
}

/** Result of a successful send. */
export interface IMessageSendResult {
	/** Resolved message id from the bridge, or a coarse fallback (`ok` / `unknown`). */
	messageId: string;
	/** The text actually delivered (post markdown-table conversion + placeholder). */
	sentText: string;
}

/** Extract a message id from the bridge's `send` result, trying common keys. */
function resolveMessageId(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const r = result as Record<string, unknown>;
	for (const key of ["messageId", "message_id", "id", "guid"]) {
		const v = r[key];
		if (typeof v === "string" && v.trim()) return v.trim();
		if (typeof v === "number" && Number.isFinite(v)) return String(v);
	}
	return null;
}

/**
 * Send an iMessage. `to` is the target string; `opts.chatId` (when set) wins and
 * forces a `chat_id:` target. Resolves the message id (or a coarse fallback).
 */
export async function sendMessageIMessage(
	to: string,
	text: string,
	opts: IMessageSendOpts = {},
): Promise<IMessageSendResult> {
	const cliPath = opts.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || undefined;

	// Target — an explicit chatId wins, else parse the `to` string.
	const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);

	// Service — explicit opt → the handle's parsed service → the account default.
	const service: IMessageService =
		opts.service ?? (target.kind === "handle" ? target.service : undefined) ?? "auto";
	const region = opts.region?.trim() || "US";
	const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : 16 * 1024 * 1024;

	let message = text ?? "";
	let filePath: string | undefined;
	let mediaKind: IMessageMediaKind | undefined = opts.mediaKind;

	// Media resolution — validate the local path, infer the kind.
	if (opts.mediaPath?.trim()) {
		const resolved = resolveOutboundAttachment(opts.mediaPath.trim(), maxBytes);
		filePath = resolved.path;
		mediaKind = mediaKind ?? resolved.kind;
		message = resolveDeliveredText(message, mediaKind);
	}

	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");

	// Plain-text-ify markdown tables when there is text.
	if (message.trim()) message = markdownToIMessageText(message);

	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");

	const replyTo = sanitizeReplyToId(opts.replyToId);

	// Assemble the wire params.
	const params: Record<string, unknown> = {
		text: message,
		service: service || "auto",
		region,
	};
	if (replyTo) params.reply_to = replyTo;
	if (filePath) params.file = filePath;
	if (target.kind === "chat_id") params.chat_id = target.chatId;
	else if (target.kind === "chat_guid") params.chat_guid = target.chatGuid;
	else if (target.kind === "chat_identifier") params.chat_identifier = target.chatIdentifier;
	else params.to = target.to;

	// Client lifecycle — an injected client is owned by the caller.
	const client: IMessageRpcLike =
		opts.client ??
		(opts.createClient
			? await opts.createClient({ cliPath, dbPath })
			: await createIMessageRpcClient({ cliPath, dbPath }));
	const shouldClose = !opts.client;
	try {
		const result = await client.request<{ ok?: string } & Record<string, unknown>>("send", params, {
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		});
		const resolvedId = resolveMessageId(result);
		return {
			messageId: resolvedId ?? (result && (result as { ok?: string }).ok ? "ok" : "unknown"),
			sentText: message,
		};
	} finally {
		if (shouldClose) await client.stop();
	}
}
