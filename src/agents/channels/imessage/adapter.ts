/**
 * iMessage channel adapter.
 *
 * Implements the Brigade `ChannelAdapter` contract on top of the `imsg` CLI
 * driven as a JSON-RPC subprocess (`connection.ts`). iMessage authenticates via
 * the local Messages.app session — there is NO bot token, so enablement is just
 * `channels.imessage.enabled: true` plus a runnable `imsg` binary. The adapter
 * declares a `setup` wizard for the binary path (so `brigade channels add` can
 * configure a non-PATH install) and has no QR/link flow.
 *
 * Modeled on `discord/adapter.ts`: same `isConfigured`→`start` config capture,
 * same health-flag mirroring, same deferred-media passthrough on inbound, same
 * chunk-then-send outbound (chunk the markdown, plain-text-ify each chunk, send).
 *
 * TEST SEAM: `connectImpl` overrides how the connection is built — production
 * leaves it undefined and `connectIMessage` lazy-spawns the subprocess (which
 * itself refuses in tests); a unit test injects a fake connection so send /
 * health / inbound dispatch run with no real binary.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { loadConfig } from "../../../core/config.js";
// Channel SDK barrel — the single import surface for the channel-authoring
// contract + shared helpers.
import {
	chunkText,
	type ChannelAdapter,
	type ChannelCapabilities,
	type ChannelHealth,
	type ChannelMessageActionResult,
	type ChannelStartContext,
	type OutboundMedia,
	type OutboundSendOptions,
} from "../sdk.js";
import {
	imessageChannelEnabled,
	listIMessageAccountIds,
	resolveIMessageAccount,
	resolveIMessageCliPath,
	IMESSAGE_CHANNEL_ID,
	IMESSAGE_DEFAULT_ACCOUNT_ID,
} from "./account-config.js";
import {
	connectIMessage,
	type ConnectIMessageArgs,
	type IMessageConnection,
	type IMessageInboundMessage,
} from "./connection.js";
import { markdownToIMessageText } from "./format.js";

/** iMessage's practical per-message text limit for chunked sends. */
const IMESSAGE_TEXT_LIMIT = 4_000;

/** iMessage capabilities — DMs + groups, media + reply; no edit/unsend/reactions via the bridge. */
export const IMESSAGE_CAPABILITIES: ChannelCapabilities = {
	chatTypes: ["direct", "group"],
	media: true,
	reply: true,
};

/** Adapter construction options — all optional for back-compat. */
export interface CreateIMessageAdapterOptions {
	/** Per-account scope. Defaults to `"default"` (single-account). */
	accountId?: string;
	/**
	 * TEST SEAM: override how the connection is built. Production leaves this
	 * undefined and `connectIMessage` lazy-spawns the `imsg` subprocess. Tests
	 * inject a fake.
	 */
	connectImpl?: (args: ConnectIMessageArgs) => Promise<IMessageConnection>;
}

async function loadStartConfig(): Promise<BrigadeConfig> {
	return loadConfig() as unknown as BrigadeConfig;
}

export function createIMessageAdapter(opts: CreateIMessageAdapterOptions = {}): ChannelAdapter {
	const accountId = opts.accountId?.trim() || IMESSAGE_DEFAULT_ACCOUNT_ID;
	const connectImpl = opts.connectImpl ?? connectIMessage;

	let connection: IMessageConnection | null = null;
	// The manager calls isConfigured(cfg, env) right before start(ctx); capture
	// them so start() reads the resolved account without a second config load.
	let lastConfig: BrigadeConfig | null = null;
	let lastEnv: NodeJS.ProcessEnv = process.env;
	// Health flags mirrored from the connection lifecycle so health() never has to
	// round-trip the subprocess.
	let connected = false;
	let closedReason: string | null = null;

	const adapter: ChannelAdapter = {
		id: IMESSAGE_CHANNEL_ID,
		label: "iMessage",

		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean {
			lastConfig = cfg;
			lastEnv = env ?? process.env;
			if (!imessageChannelEnabled(cfg)) return false;
			// Need a resolvable `imsg` binary path (always resolves to at least the
			// default "imsg"); enablement is the real gate.
			if (!resolveIMessageCliPath(cfg, accountId, env ?? process.env)) return false;
			// Multi-account: the plugin path owns lifecycle when >1 account; the
			// legacy single adapter steps aside.
			const isLegacyAdapter = accountId === IMESSAGE_DEFAULT_ACCOUNT_ID;
			if (isLegacyAdapter && listIMessageAccountIds(cfg).length > 1) return false;
			return true;
		},

		async start(ctx: ChannelStartContext): Promise<void> {
			const cfg = lastConfig ?? (await loadStartConfig());
			const account = resolveIMessageAccount(cfg, accountId, lastEnv);
			try {
				const conn = await connectImpl({
					account,
					loadConfig: () => (lastConfig ?? cfg),
					log: ctx.log,
					...(ctx.signal ? { signal: ctx.signal } : {}),
					onConnected: () => {
						connected = true;
						closedReason = null;
						ctx.log("iMessage connected");
						ctx.onConnected?.();
					},
					onClosed: (reason) => {
						connected = false;
						closedReason = reason;
						ctx.log(`iMessage transport closed: ${reason}`);
						ctx.onLoggedOut?.();
					},
					onMessage: (msg: IMessageInboundMessage) => {
						void ctx.onInbound({
							channel: IMESSAGE_CHANNEL_ID,
							accountId,
							conversationId: msg.conversationId,
							...(msg.messageId ? { messageId: msg.messageId } : {}),
							...(msg.createdAtMs !== undefined ? { messageTimestampMs: msg.createdAtMs } : {}),
							from: msg.from,
							...(msg.fromName !== undefined ? { fromName: msg.fromName } : {}),
							text: msg.text,
							chatType: msg.isGroup ? "group" : "direct",
							isGroup: msg.isGroup,
							...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
							// Deferred media thunk rides through untouched — the pipeline
							// resolves it only after the access gate admits the sender.
							...(msg.resolveMedia ? { resolveMedia: msg.resolveMedia } : {}),
							raw: msg.raw,
						});
					},
				});
				connection = conn;
			} catch (err) {
				connected = false;
				closedReason = err instanceof Error ? err.message : String(err);
				ctx.log(`iMessage failed to start: ${closedReason}`);
			}
		},

		async stop(): Promise<void> {
			await connection?.close();
			connection = null;
			connected = false;
		},

		health(): ChannelHealth {
			if (!connection) {
				return { ok: false, kind: "starting", reason: "iMessage adapter is not started yet." };
			}
			if (!connected || !connection.isConnected()) {
				return {
					ok: false,
					kind: "disconnected",
					reason: closedReason
						? `iMessage is not connected — ${closedReason}.`
						: "iMessage is reconnecting — sends will fail until the imsg bridge resumes.",
					remediation: "Ensure the imsg CLI is installed and Messages.app is signed in.",
				};
			}
			return { ok: true };
		},

		async sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("iMessage channel is not started");
			// Chunk on the raw markdown (so fences/paragraphs aren't shredded), then
			// plain-text-ify each chunk and send.
			const chunks = chunkText(text, { limit: IMESSAGE_TEXT_LIMIT });
			let first = true;
			let lastMessageId: string | undefined;
			for (const chunk of chunks) {
				const body = markdownToIMessageText(chunk);
				if (body.trim().length === 0) continue;
				// Native reply target applies to the FIRST chunk only.
				const replyOpt = first && opts?.replyToId ? { replyToId: opts.replyToId } : {};
				const sent = await connection.sendText(conversationId, body, { ...replyOpt });
				if (sent.messageId) lastMessageId = sent.messageId;
				first = false;
			}
			return lastMessageId ? { messageId: lastMessageId } : undefined;
		},

		async sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string } | void> {
			if (!connection) throw new Error("iMessage channel is not started");
			const sent = await connection.sendMedia(conversationId, media);
			return sent.messageId ? { messageId: sent.messageId } : undefined;
		},

		selfId(): string | undefined {
			return undefined;
		},

		connectedAt(): number | null {
			return connection?.connectedAt() ?? null;
		},

		// iMessage senders are phone numbers / emails on the operator's own device;
		// the bot runs AS the operator (Messages.app), so the pairing card uses the
		// "account" label and ownership is NOT bootstrapped from a separate bot.
		pairing: { idLabel: "account" as const },

		// The `imsg` binary path is the only "credential" — `brigade channels add`
		// prompts for it (default "imsg" on PATH). Messages.app sign-in is the real
		// auth and can't be configured here.
		setup: {
			credentialKeys: [
				{
					key: "cliPath",
					prompt:
						"Path to the `imsg` CLI binary (leave blank to use `imsg` on PATH). Requires Messages.app signed in on this Mac.",
					secret: false,
					envVar: "IMSG_CLI_PATH",
				},
			],
			validateInput(key: string, value: string): string | null {
				if (key === "cliPath" && value.trim() && /\s$/.test(value)) return "Path must not end with whitespace.";
				return null;
			},
			buildAccountConfig(values: Record<string, string>): Record<string, unknown> {
				const out: Record<string, unknown> = { enabled: true };
				const cliPath = (values.cliPath ?? "").trim();
				if (cliPath) out.cliPath = cliPath;
				return out;
			},
		},

		capabilities: IMESSAGE_CAPABILITIES,

		// iMessage has no edit/delete/react/pin via the bridge; the central
		// message_action tool pre-checks `capabilities` (none advertised beyond
		// reply), so this reports anything else unsupported cleanly.
		async handleAction(): Promise<ChannelMessageActionResult> {
			return { ok: false, error: "iMessage does not support message actions" };
		},
	};

	return adapter;
}
