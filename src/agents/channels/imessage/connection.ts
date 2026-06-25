/**
 * iMessage transport connection — the live `imsg rpc` subprocess lifecycle.
 *
 * `connectIMessage` owns a long-lived {@link IMessageRpcLike} client, subscribes
 * to inbound notifications (`watch.subscribe`), runs each `message` notification
 * through the monitor's gating brain (`decideInbound`), and hands dispatched
 * inbounds to `onMessage`. It also exposes the outbound `sendText` / `sendMedia`
 * (which `remember` every send in the echo cache so the inbound poll drops the
 * echo) + reconnect with the shared jittered backoff.
 *
 * TEST SEAM: `clientFactory` builds the RPC client — production lets it default
 * to the real {@link createIMessageRpcClient} (which itself refuses to spawn in
 * tests); a unit test injects a fake satisfying {@link IMessageRpcLike}. The
 * adapter layers a second seam (`connectImpl`) on top, mirroring Discord. No
 * `isTestEnv` flag is consulted here — the seam is pure dependency injection.
 */

import { nextBackoffDelay } from "../sdk.js";
import { resolveIMessageAttachmentRoots, type ResolvedIMessageAccount } from "./account-config.js";
import {
	createIMessageRpcClient,
	type IMessageRpcLike,
	type IMessageRpcNotification,
} from "./client.js";
import { inferOutboundMediaKind, resolveInboundAttachments } from "./media.js";
import {
	createMonitorState,
	decideInbound,
	echoScope,
	normalizeIMessageMessage,
	parseIMessageNotification,
	type MonitorState,
	type NormalizedIMessage,
} from "./monitor.js";
import { sendMessageIMessage, type IMessageSendResult } from "./send.js";
import type { BrigadeConfig } from "../sdk.js";
import type { OutboundMedia, OutboundSendOptions, InboundMediaAttachment } from "../sdk.js";

/** Reconnect schedule constants — mirror the shared WhatsApp curve. */
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

/** The inbound message the connection hands the adapter (carries the deferred-media thunk). */
export interface IMessageInboundMessage extends NormalizedIMessage {
	/** Deferred inbound-media resolver (invoked only after the access gate admits the sender). */
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
}

/** Args for {@link connectIMessage}. */
export interface ConnectIMessageArgs {
	account: ResolvedIMessageAccount;
	/** Active config — used to resolve inbound attachment roots per message. */
	loadConfig: () => BrigadeConfig;
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Fired once the subscription is live. */
	onConnected?: () => void;
	/** Fired when the transport gives up (binary gone / fatal). */
	onClosed?: (reason: string) => void;
	/** Dispatched inbound (post gating + dedupe). */
	onMessage: (msg: IMessageInboundMessage) => void;
	signal?: AbortSignal;
	/** TEST SEAM: build the RPC client. Defaults to the real subprocess client. */
	clientFactory?: (opts: {
		cliPath: string;
		dbPath?: string;
		onNotification: (msg: IMessageRpcNotification) => void;
		runtime: { error?: (m: string) => void; info?: (m: string) => void };
	}) => Promise<IMessageRpcLike>;
	/** TEST SEAM: replace the real `sendMessageIMessage` (so outbound tests need no client). */
	sendImpl?: typeof sendMessageIMessage;
	/** TEST SEAM: replace the backoff sleep (instant reconnect in tests). */
	sleepImpl?: (ms: number) => Promise<void>;
}

/** The live connection handle the adapter drives. */
export interface IMessageConnection {
	isConnected(): boolean;
	connectedAt(): number | null;
	/** Send text; returns the bridge message id when available. */
	sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string }>;
	/** Send media; returns the bridge message id when available. */
	sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string }>;
	/** Tear down the subprocess + stop reconnecting. */
	close(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
	});

/**
 * Open the iMessage transport. Resolves once the first subscription is live (or
 * the connect terminally fails). Keeps reconnecting in the background until
 * `close()` / the abort signal fires.
 */
export async function connectIMessage(args: ConnectIMessageArgs): Promise<IMessageConnection> {
	const { account } = args;
	const state: MonitorState = createMonitorState();
	const sleep = args.sleepImpl ?? defaultSleep;
	const sendFn = args.sendImpl ?? sendMessageIMessage;
	const clientFactory =
		args.clientFactory ??
		(async (opts) =>
			createIMessageRpcClient({
				cliPath: opts.cliPath,
				...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
				onNotification: opts.onNotification,
				runtime: opts.runtime,
			}));

	let client: IMessageRpcLike | null = null;
	let connected = false;
	let connectedAtMs: number | null = null;
	let closed = false;
	let attempt = 0;

	const handleNotification = (msg: IMessageRpcNotification): void => {
		// Wrap the whole handler so a synchronous throw (malformed payload, a
		// decideInbound bug, a downstream onMessage error) can NEVER escape into the
		// RPC client's notification loop and wedge the watch / crash the gateway.
		// The transport keeps reading; a single bad notification is logged + dropped.
		try {
			if (msg.method === "error") {
				args.log("imessage watch error", { params: msg.params });
				return;
			}
			if (msg.method !== "message") return;
			const payload = parseIMessageNotification(msg.params);
			if (!payload) {
				args.log("dropping malformed iMessage payload");
				return;
			}
			const decision = decideInbound(state, account.accountId, payload);
			if (decision.kind === "drop") {
				if (account.verbose) args.log(`inbound dropped: ${decision.reason}`);
				return;
			}
			const normalized = decision.message;
			// Deferred media — resolve only after the central access gate admits the
			// sender (the bridge has already saved the bytes to disk; we just map them).
			const inbound: IMessageInboundMessage = { ...normalized };
			if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
				inbound.resolveMedia = async () => {
					const roots = resolveIMessageAttachmentRoots(args.loadConfig(), account.accountId);
					return resolveInboundAttachments(payload.attachments, roots);
				};
			}
			args.onMessage(inbound);
		} catch (err) {
			args.log("imessage notification handler threw (dropped, loop continues)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const subscribeOnce = async (): Promise<void> => {
		const c = await clientFactory({
			cliPath: account.cliPath,
			...(account.dbPath ? { dbPath: account.dbPath } : {}),
			onNotification: handleNotification,
			runtime: {
				error: (m) => args.log(m),
				info: (m) => account.verbose && args.log(m),
			},
		});
		client = c;
		await c.request("watch.subscribe", { attachments: true }, { timeoutMs: account.probeTimeoutMs });
		connected = true;
		connectedAtMs = Date.now();
		attempt = 0;
		args.onConnected?.();
	};

	/** Background supervise loop — reconnect with jittered backoff until closed. */
	const supervise = async (): Promise<void> => {
		while (!closed && !args.signal?.aborted) {
			try {
				if (!connected) await subscribeOnce();
				// Block on the client closing; on close, fall through to reconnect.
				await client?.waitForClose();
			} catch (err) {
				args.log("imessage connect attempt failed", { error: err instanceof Error ? err.message : String(err) });
			}
			connected = false;
			try {
				await client?.stop();
			} catch {
				/* best-effort */
			}
			client = null;
			if (closed || args.signal?.aborted) break;
			attempt += 1;
			if (attempt > RECONNECT_MAX_ATTEMPTS) {
				args.onClosed?.(`gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts`);
				break;
			}
			const delay = nextBackoffDelay({
				attempt,
				initialMs: RECONNECT_INITIAL_MS,
				maxMs: RECONNECT_MAX_MS,
				factor: RECONNECT_FACTOR,
				jitter: RECONNECT_JITTER,
			});
			await sleep(delay);
		}
	};

	// First connect — surface a failure to the caller; keep the loop running after.
	await subscribeOnce();
	void supervise();

	if (args.signal) {
		if (args.signal.aborted) closed = true;
		else args.signal.addEventListener("abort", () => void close(), { once: true });
	}

	const remember = (conversationId: string, sent: IMessageSendResult): void => {
		// Build the same scope the inbound poll keys on so the echo is suppressed.
		const numericChat = conversationId.startsWith("chat:") ? Number.parseInt(conversationId.slice(5), 10) : NaN;
		const scope = Number.isFinite(numericChat)
			? echoScope(account.accountId, { chat_id: numericChat })
			: `${account.accountId}:imessage:${conversationId}`;
		state.sentMessageCache.remember(scope, { text: sent.sentText, messageId: sent.messageId });
	};

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		try {
			await client?.stop();
		} catch {
			/* best-effort */
		}
		client = null;
		connected = false;
	}

	return {
		isConnected: () => connected,
		connectedAt: () => connectedAtMs,
		async sendText(conversationId, text, opts): Promise<{ messageId?: string }> {
			const result = await sendFn(conversationId, text, {
				cliPath: account.cliPath,
				...(account.dbPath ? { dbPath: account.dbPath } : {}),
				service: account.service,
				region: account.region,
				maxBytes: account.mediaMaxBytes,
				timeoutMs: account.probeTimeoutMs,
				...(client ? { client } : {}),
				...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
			});
			remember(conversationId, result);
			return result.messageId ? { messageId: result.messageId } : {};
		},
		async sendMedia(conversationId, media): Promise<{ messageId?: string }> {
			const result = await sendFn(conversationId, media.caption ?? "", {
				cliPath: account.cliPath,
				...(account.dbPath ? { dbPath: account.dbPath } : {}),
				service: account.service,
				region: account.region,
				maxBytes: account.mediaMaxBytes,
				timeoutMs: account.probeTimeoutMs,
				mediaPath: media.path,
				mediaKind: inferOutboundMediaKind(media),
				...(client ? { client } : {}),
			});
			remember(conversationId, result);
			return result.messageId ? { messageId: result.messageId } : {};
		},
		close,
	};
}

export { normalizeIMessageMessage };
