/**
 * WhatsApp Web connection (Baileys).
 *
 * A multi-file auth store on disk, QR-on-first-link, auto-reconnect with
 * backoff, and a normalized text-message callback. Baileys is a heavy
 * dependency, so it is lazy-imported here — the gateway only pays for it when a
 * WhatsApp channel actually starts. Types are imported `type`-only (erased at
 * build) so the static import never pulls the runtime in.
 *
 * Reconnect discipline: on a transient drop the live socket is fully torn down
 * (listeners removed + ended) BEFORE a replacement is built, and the rebuild is
 * scheduled on a backoff timer rather than synchronously inside the close
 * handler — so a flapping link can never fork into parallel reconnect chains or
 * leak listeners. A logged-out close stops reconnection entirely (creds are
 * dead). `close()` cancels any pending reconnect and tears the socket down.
 *
 * Scope (this phase): text in / text out. Media, reactions, groups-as-rooms,
 * and presence are deliberately out of scope and slot in later behind the same
 * ChannelAdapter contract.
 */

import type { ConnectionState, WAMessage, WASocket } from "@whiskeysockets/baileys";

/** A normalized inbound WhatsApp text message. */
export interface WaInboundText {
	/** Chat JID — the conversation id (e.g. `123@s.whatsapp.net`). */
	conversationId: string;
	/** Sender JID. */
	from: string;
	/** WhatsApp display name, when present. */
	fromName?: string;
	/** Plain message text. */
	text: string;
	/** Raw Baileys message (for adapters that need more). */
	raw: WAMessage;
}

export interface ConnectWhatsAppArgs {
	/** Directory holding the multi-file auth state (creds + signal keys). */
	authDir: string;
	/** Baileys log level — quiet unless the operator asked for verbose. */
	verbose?: boolean;
	/** Called with the QR string whenever WhatsApp wants the device linked. */
	onQr?: (qr: string) => void;
	/** Called once the socket reaches the `open` state. */
	onConnected?: () => void;
	/** Called when WhatsApp ends the session (creds invalid — re-link needed). */
	onLoggedOut?: () => void;
	/** Called for every inbound text message from another user. */
	onMessage: (msg: WaInboundText) => void;
	/** Subsystem logger. */
	log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WhatsAppConnection {
	/** The live Baileys socket (rebuilt internally across reconnects). */
	current(): WASocket | null;
	/** Send a text message to a chat JID. */
	sendText(conversationId: string, text: string): Promise<void>;
	/** Close the connection and stop reconnecting. */
	close(): Promise<void>;
}

// Reconnect backoff: 2s → 30s, ×1.8 with ±25% jitter, capped attempts so a
// permanently-broken link stops hammering WhatsApp instead of looping forever.
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_FACTOR = 1.8;
const RECONNECT_JITTER = 0.25;
const RECONNECT_MAX_ATTEMPTS = 12;

function backoffDelay(attempt: number): number {
	const base = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * RECONNECT_FACTOR ** attempt);
	const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
	return Math.max(0, Math.round(base + jitter));
}

/** Extract plain text from a Baileys message, unwrapping the common envelopes. */
function extractText(message: WAMessage["message"], normalize: (m: unknown) => unknown): string {
	const content = (normalize(message) ?? {}) as Record<string, unknown>;
	if (typeof content.conversation === "string") return content.conversation;
	const ext = content.extendedTextMessage as { text?: string } | undefined;
	if (ext && typeof ext.text === "string") return ext.text;
	// Image/video/document with a caption — treat the caption as the text.
	const img = content.imageMessage as { caption?: string } | undefined;
	if (img && typeof img.caption === "string") return img.caption;
	const vid = content.videoMessage as { caption?: string } | undefined;
	if (vid && typeof vid.caption === "string") return vid.caption;
	const doc = content.documentMessage as { caption?: string } | undefined;
	if (doc && typeof doc.caption === "string") return doc.caption;
	return "";
}

/**
 * Establish a WhatsApp Web connection with auto-reconnect. Resolves once the
 * first socket is constructed (NOT once connected — QR/open events arrive via
 * the callbacks). The returned handle owns the reconnect loop.
 */
export async function connectWhatsApp(args: ConnectWhatsAppArgs): Promise<WhatsAppConnection> {
	const baileys = await import("@whiskeysockets/baileys");
	const makeWASocket = (baileys.default ?? baileys.makeWASocket) as typeof import("@whiskeysockets/baileys").makeWASocket;
	const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, normalizeMessageContent, useMultiFileAuthState } =
		baileys;

	const loggedOutCode = DisconnectReason?.loggedOut ?? 401;
	const restartRequiredCode = DisconnectReason?.restartRequired ?? 515;

	// Silent pino-shaped logger unless verbose — Baileys logs prolifically.
	const level = args.verbose ? "info" : "silent";
	const noop = () => {};
	const baileysLogger: Record<string, unknown> = {
		level,
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => baileysLogger,
	};

	const { state, saveCreds } = await useMultiFileAuthState(args.authDir);
	const { version } = await fetchLatestBaileysVersion();

	let sock: WASocket | null = null;
	let closed = false;
	let reconnectAttempts = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Pending creds writes are tracked so a reconnect (notably the 515 that
	// follows first-link) can wait for them to flush before rebuilding.
	let pendingCredsSave: Promise<void> = Promise.resolve();

	/** Detach every listener from a socket and end it — no zombie emits. */
	const teardownSocket = (s: WASocket | null): void => {
		if (!s) return;
		try {
			(s.ev as unknown as { removeAllListeners?: () => void }).removeAllListeners?.();
		} catch {
			/* best-effort */
		}
		try {
			const ws = (s as unknown as { ws?: { removeAllListeners?: () => void } }).ws;
			ws?.removeAllListeners?.();
		} catch {
			/* best-effort */
		}
		try {
			s.end?.(undefined);
		} catch {
			/* already torn down */
		}
	};

	const scheduleReconnect = (): void => {
		if (closed || reconnectTimer) return;
		if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
			args.log("WhatsApp reconnect attempts exhausted — giving up until restart", {
				attempts: reconnectAttempts,
			});
			return;
		}
		const delay = backoffDelay(reconnectAttempts);
		reconnectAttempts += 1;
		args.log("WhatsApp reconnecting", { attempt: reconnectAttempts, delayMs: delay });
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			if (closed) return;
			// Flush any pending creds write first (covers the 515 first-link race),
			// then build a fresh socket on the same creds.
			void pendingCredsSave
				.catch(() => {})
				.then(() => {
					if (closed) return;
					sock = buildSocket();
				});
		}, delay);
		reconnectTimer.unref?.();
	};

	const buildSocket = (): WASocket => {
		const s = makeWASocket({
			version,
			// biome-ignore lint/suspicious/noExplicitAny: pino-shaped stub logger
			logger: baileysLogger as any,
			printQRInTerminal: false,
			browser: ["Brigade", "Chrome", "1.0.0"],
			syncFullHistory: false,
			markOnlineOnConnect: false,
			auth: {
				creds: state.creds,
				// biome-ignore lint/suspicious/noExplicitAny: pino-shaped stub logger
				keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
			},
		});

		s.ev.on("creds.update", () => {
			pendingCredsSave = Promise.resolve(saveCreds()).catch((err) => {
				args.log("failed saving WhatsApp creds", { error: err instanceof Error ? err.message : String(err) });
			});
		});

		s.ev.on("connection.update", (update: Partial<ConnectionState>) => {
			// Wrap the whole handler — a throw inside a Baileys event emit would
			// otherwise surface as an unhandled rejection and could crash the daemon.
			try {
				const { connection, lastDisconnect, qr } = update;
				if (qr) args.onQr?.(qr);
				if (connection === "open") {
					reconnectAttempts = 0; // healthy link — reset backoff
					args.log("connected to WhatsApp");
					args.onConnected?.();
				}
				if (connection === "close") {
					const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
						?.statusCode;
					// Tear the dead socket down BEFORE doing anything else so its
					// listeners can't fire again (no leak, no duplicate inbound).
					teardownSocket(s);
					if (sock === s) sock = null;
					if (status === loggedOutCode) {
						args.log("WhatsApp session logged out — re-link required");
						args.onLoggedOut?.();
						return; // dead creds — never reconnect
					}
					if (status === restartRequiredCode) {
						// Expected immediately after first-link; reconnect promptly
						// without consuming the backoff budget.
						args.log("WhatsApp restart required (post-link) — reconnecting");
						reconnectAttempts = 0;
					}
					scheduleReconnect();
				}
			} catch (err) {
				args.log("WhatsApp connection.update handler error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		s.ev.on("messages.upsert", (payload: { messages: WAMessage[]; type: string }) => {
			// `notify` = live messages; `append`/history-sync are ignored so we
			// never replay old chats on reconnect.
			if (payload.type !== "notify") return;
			for (const m of payload.messages) {
				try {
					if (m.key.fromMe) continue; // our own outbound
					const jid = m.key.remoteJid;
					if (!jid || jid === "status@broadcast") continue; // status updates
					// Groups are out of scope this phase — never auto-reply into a
					// group the linked number happens to be in.
					if (jid.endsWith("@g.us")) continue;
					const text = extractText(m.message, normalizeMessageContent as (x: unknown) => unknown).trim();
					if (!text) continue; // non-text (sticker/audio/etc.)
					args.onMessage({
						conversationId: jid,
						from: m.key.participant ?? jid,
						fromName: m.pushName ?? undefined,
						text,
						raw: m,
					});
				} catch (err) {
					args.log("failed to process inbound message", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		});

		// Surface socket-level WS errors instead of crashing the process.
		const ws = (s as unknown as { ws?: { on?: (e: string, cb: (err: Error) => void) => void } }).ws;
		ws?.on?.("error", (err) => args.log("WhatsApp socket error", { error: String(err) }));

		return s;
	};

	sock = buildSocket();

	return {
		current: () => sock,
		async sendText(conversationId: string, text: string): Promise<void> {
			if (!sock) throw new Error("WhatsApp socket not connected");
			await sock.sendMessage(conversationId, { text });
		},
		async close(): Promise<void> {
			closed = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			// `logout()` would invalidate creds; we want a clean disconnect that
			// keeps the link, so just tear the socket down.
			teardownSocket(sock);
			sock = null;
			// Let a final creds write flush so the link survives a restart.
			await pendingCredsSave.catch(() => {});
		},
	};
}
