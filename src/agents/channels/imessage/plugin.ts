/**
 * iMessage `ChannelPlugin` — the multi-ACCOUNT contract surface.
 *
 * Mirrors `discord/plugin.ts`: wraps `createIMessageAdapter()` (the
 * per-connection implementation) with the lifecycle adapters the
 * `ChannelPluginManager` consumes, so an operator can run MORE THAN ONE iMessage
 * bridge at once (e.g. two Macs / two chat.db files) via:
 *
 *   channels.imessage = {
 *     enabled: true,
 *     accounts: [
 *       { id: "personal", dbPath: "~/Library/Messages/chat.db" },
 *       { id: "work",     cliPath: "/opt/imsg/bin/imsg" },
 *     ],
 *   }
 *
 * Per-account state lives in a `Map<accountId, AccountRuntime>` in this closure —
 * one `imsg rpc` subprocess per account. Inbound dispatch reuses the shared
 * `runChannelInboundPipeline` so the multi-account path carries the identical
 * ACL + debounce + abort surface as the legacy single-adapter manager.
 *
 * The legacy single-account `createIMessageAdapter` STEPS ASIDE when >1 account
 * is configured (its `isConfigured` returns false for the default account), so
 * the two paths never double-start a subprocess. iMessage has no inbound HTTP
 * route (the `imsg rpc` notification stream is the only inbound transport).
 */

import type { BrigadeConfig } from "../../../config/types.js";
// Channel SDK barrel — the single import surface for the multi-account
// `ChannelPlugin` contract + the shared inbound pipeline + the gateway boot args.
import {
	buildBundledCommands,
	createInboundPipelineContext,
	createSubsystemLogger,
	runChannelInboundPipeline,
	type ChannelAdapter,
	type ChannelCommand,
	type ChannelGatewayContext,
	type ChannelLogoutContext,
	type ChannelLogoutResult,
	type ChannelOutboundTarget,
	type ChannelPlugin,
	type ChannelStartContext,
	type InboundMessage,
	type InboundPipelineContext,
	type RunChannelTurnFn,
	type StartChannelsArgs,
	IMESSAGE_CHANNEL_META,
} from "../sdk.js";
import {
	listIMessageAccountIds,
	resolveIMessageAccount,
	resolveIMessageCliPath,
	resolveIMessageDbPath,
	resolveIMessageProbeTimeoutMs,
	IMESSAGE_CHANNEL_ID,
	IMESSAGE_DEFAULT_ACCOUNT_ID,
	type ResolvedIMessageAccount,
} from "./account-config.js";
import { createIMessageAdapter, IMESSAGE_CAPABILITIES } from "./adapter.js";
import { imessageMessagingAdapter } from "./messaging.js";
import { probeIMessage, type IMessageProbeResult } from "./probe.js";

const log = createSubsystemLogger("channels/imessage/plugin");

const IMESSAGE_META = IMESSAGE_CHANNEL_META;

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface IMessagePluginDeps {
	defaultAgentId: string;
	loadConfig: () => BrigadeConfig;
	runTurn: StartChannelsArgs["runTurn"];
	/** Optional adapter factory — tests inject a fake; production uses `createIMessageAdapter`. */
	adapterFactory?: (args: { accountId: string }) => ChannelAdapter;
}

/** Operator-grade view of a per-account bridge — exposed via attached helpers. */
export interface IMessagePluginRuntimeView {
	startedAccountIds(): string[];
	getAdapter(accountId: string): ChannelAdapter | undefined;
	probeAccount(accountId: string, cfg: BrigadeConfig): Promise<IMessageProbeResult>;
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type IMessagePluginHandle = ChannelPlugin<ResolvedIMessageAccount> & IMessagePluginRuntimeView;

/** Construct the plugin instance, capturing per-account runtime state in closure. */
export function createIMessagePlugin(deps: IMessagePluginDeps): IMessagePluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (ctx: ChannelGatewayContext<ResolvedIMessageAccount>): Promise<void> => {
		const accountId = ctx.accountId || IMESSAGE_DEFAULT_ACCOUNT_ID;
		const existing = accountRuntimes.get(accountId);
		if (existing) {
			try {
				await existing.adapter.stop();
			} catch {
				/* best-effort */
			}
			try {
				existing.abort.abort("restart");
			} catch {
				/* best-effort */
			}
			accountRuntimes.delete(accountId);
		}

		const cfg = deps.loadConfig();
		const factory = deps.adapterFactory ?? defaultIMessageAdapterFactory;
		const adapter = factory({ accountId });

		const accountAbort = new AbortController();
		const parent = ctx.signal;
		if (parent) {
			if (parent.aborted) accountAbort.abort();
			else parent.addEventListener("abort", () => accountAbort.abort(), { once: true });
		}

		const pipelineRunTurn: RunChannelTurnFn = (turn) => deps.runTurn(turn);
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of buildBundledCommands(adapter)) commandMap.set(c.name.toLowerCase(), c);
		const pipeline = createInboundPipelineContext({
			adapter,
			config: cfg,
			agentId: deps.defaultAgentId,
			runTurn: pipelineRunTurn,
			commandMap,
			parentAbort: accountAbort.signal,
		});

		const startCtx: ChannelStartContext = {
			signal: accountAbort.signal,
			log: (msg, meta) => log.info(`[${accountId}] ${msg}`, meta),
			onInbound: async (msg: InboundMessage) => {
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			log.info("imessage account started", { accountId });
		} catch (err) {
			log.warn("imessage account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (ctx: ChannelGatewayContext<ResolvedIMessageAccount>): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		try {
			runtime.abort.abort("stop-requested");
		} catch {
			/* best-effort */
		}
		for (const slot of runtime.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		runtime.pipeline.pendingDispatches.clear();
		try {
			await runtime.adapter.stop();
		} catch (err) {
			log.warn("imessage account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (ctx: ChannelLogoutContext<ResolvedIMessageAccount>): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: IMESSAGE_CHANNEL_ID,
		meta: IMESSAGE_META,
		capabilities: IMESSAGE_CAPABILITIES,
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		probeAccount: async (accountId, cfg): Promise<IMessageProbeResult> => {
			return probeIMessage({
				cliPath: resolveIMessageCliPath(cfg, accountId),
				...(resolveIMessageDbPath(cfg, accountId) ? { dbPath: resolveIMessageDbPath(cfg, accountId) } : {}),
				timeoutMs: resolveIMessageProbeTimeoutMs(cfg, accountId),
			});
		},
		config: {
			listAccountIds: (cfg) => listIMessageAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveIMessageAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => IMESSAGE_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || IMESSAGE_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) return { ok: false, error: `imessage account "${accountId}" is not running` };
				try {
					const sent = await runtime.adapter.sendText(params.target.to, params.text, { accountId });
					return {
						ok: true,
						...(sent && typeof sent === "object" && sent.messageId !== undefined ? { messageId: sent.messageId } : {}),
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || IMESSAGE_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `imessage account "${accountId}" cannot send media right now` };
				}
				try {
					await runtime.adapter.sendMedia(params.target.to, {
						kind: (params.mediaType as never) ?? "document",
						path: params.mediaUrl,
						...(params.caption !== undefined ? { caption: params.caption } : {}),
					});
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},
		// Outbound addressing: parse/normalize a loose `to` into a concrete target.
		messaging: imessageMessagingAdapter,
		secrets: {
			// iMessage has no token secret; the cliPath isn't a secret-ref, so no
			// secret-target entries. Declared empty for surface parity.
			secretTargetRegistryEntries: [],
		},
	};
}

/** Default adapter factory — threads the per-account scope. */
function defaultIMessageAdapterFactory(args: { accountId: string }): ChannelAdapter {
	return createIMessageAdapter({ accountId: args.accountId });
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type IMessageOutboundTarget = ChannelOutboundTarget;
