/**
 * Slack `ChannelPlugin` — the multi-WORKSPACE contract surface.
 *
 * Mirrors `telegram/plugin.ts`: wraps `createSlackAdapter()` (the per-connection
 * implementation) with the lifecycle adapters the `ChannelPluginManager`
 * consumes, so an operator can run MORE THAN ONE Slack workspace at once via:
 *
 *   channels.slack = {
 *     enabled: true,
 *     accounts: [
 *       { id: "acme", botToken: "xoxb-AAA", appToken: "xapp-AAA" },
 *       { id: "labs", botToken: "xoxb-BBB", appToken: "xapp-BBB" },
 *     ],
 *   }
 *
 *   - `config.listAccountIds` / `resolveAccount`  → multi-workspace discovery
 *   - `gateway.startAccount` / `stopAccount`      → per-workspace app lifecycle
 *   - `outbound.sendText` / `sendMedia`           → routes by `target.accountId`
 *   - per-account approval-dispatcher registration → an exec-gate prompt raised
 *     by a turn on (slack, labs) replies on (slack, labs), not the default
 *
 * Per-account state lives in a `Map<accountId, AccountRuntime>` held in this
 * closure — one app connection per account, partitioned token resolution per
 * `channels.slack.accounts[].botToken`. Inbound dispatch reuses the shared
 * `runChannelInboundPipeline` so the multi-workspace path carries the identical
 * ACL + debounce + abort + approval-reply + approval-callback surface as the
 * legacy single-adapter manager.
 *
 * The legacy single-account `createSlackAdapter` (started by the legacy
 * `startChannels` manager) STEPS ASIDE when >1 account is configured — its
 * `isConfigured` returns false for the default account in that case (mirrors
 * Telegram), so the two paths never double-start an app.
 */

import type { BrigadeConfig } from "../../../config/types.js";
// Channel SDK barrel — the SINGLE import surface for the multi-account
// `ChannelPlugin` contract + every sub-adapter type + the shared inbound
// pipeline + the approval router + the gateway boot args. A multi-account
// channel authors entirely from here.
import {
	buildBundledCommands,
	createInboundPipelineContext,
	createSubsystemLogger,
	registerChannelApprovalDispatcher,
	removeChannelApprovalDispatcher,
	runChannelInboundPipeline,
	type ChannelAdapter,
	type ChannelApprovalCapability,
	type ChannelApprovalPromptParams,
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
	SLACK_CHANNEL_META,
} from "../sdk.js";
import {
	listSlackAccountIds,
	resolveSlackAccount,
	resolveSlackBotToken,
	SLACK_CHANNEL_ID,
	SLACK_DEFAULT_ACCOUNT_ID,
	type ResolvedSlackAccount,
} from "./account-config.js";
import { registerSlackAccountSink, removeSlackAccountSink } from "./account-registry.js";
import { createSlackAdapter, SLACK_CAPABILITIES, type SlackAdapter } from "./adapter.js";
import { probeSlack, type SlackProbeResult } from "./probe.js";

const log = createSubsystemLogger("channels/slack/plugin");

// Single source of truth for the channel's user-facing metadata lives in the
// import-light `bundled-channel-metas` module (re-exported via the SDK barrel),
// so the registry / markdown gate can read it without loading this adapter.
// `SLACK_CHANNEL_META.id` is the same canonical `"slack"` string as
// `SLACK_CHANNEL_ID`.
const SLACK_META = SLACK_CHANNEL_META;

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface SlackPluginDeps {
	/** Boot-time default agent for routing fallbacks. */
	defaultAgentId: string;
	/** Active gateway config — re-read fresh per inbound for live policy. */
	loadConfig: () => BrigadeConfig;
	/** Run one agent turn (the gateway's serialised turn executor). */
	runTurn: StartChannelsArgs["runTurn"];
	/**
	 * Optional adapter factory — tests inject a fake; production uses
	 * `createSlackAdapter`. Receives the per-account scope.
	 */
	adapterFactory?: (args: { accountId: string }) => ChannelAdapter;
}

/** Operator-grade view of a per-account app — exposed via attached helpers. */
export interface SlackPluginRuntimeView {
	/** Currently-running account ids. */
	startedAccountIds(): string[];
	/** Look up the per-account adapter (or undefined when the account isn't started). */
	getAdapter(accountId: string): ChannelAdapter | undefined;
	/** Run an `auth.test` probe for an account (for status / doctor). */
	probeAccount(accountId: string, cfg: BrigadeConfig): Promise<SlackProbeResult>;
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type SlackPluginHandle = ChannelPlugin<ResolvedSlackAccount> & SlackPluginRuntimeView;

/** Build the per-account approval capability — the native Block Kit prompt + approver gate. */
function buildApprovalCapability(adapter: ChannelAdapter, accountId: string): ChannelApprovalCapability {
	return {
		async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
			// Delegate to the adapter's own native prompt (Block Kit buttons). The
			// adapter throws when the approval id can't be encoded, so the router
			// falls back to its text prompt — mirror that here.
			const cap = adapter.approvalCapability?.sendApprovalPrompt;
			if (!cap) throw new Error("slack adapter has no approval prompt");
			await cap({ ...params, accountId });
		},
		authorizeApprover(p) {
			const cap = adapter.approvalCapability?.authorizeApprover;
			if (!cap) return { authorized: true };
			return cap(p);
		},
	};
}

/** Construct the plugin instance, capturing per-account runtime state in closure. */
export function createSlackPlugin(deps: SlackPluginDeps): SlackPluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (ctx: ChannelGatewayContext<ResolvedSlackAccount>): Promise<void> => {
		const accountId = ctx.accountId || SLACK_DEFAULT_ACCOUNT_ID;
		// Re-entrant start (the plugin-manager's restart loop) — stop the prior
		// adapter, then build fresh.
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
			removeChannelApprovalDispatcher(SLACK_CHANNEL_ID, accountId);
			removeSlackAccountSink(accountId);
			accountRuntimes.delete(accountId);
		}

		const cfg = deps.loadConfig();
		const factory = deps.adapterFactory ?? defaultSlackAdapterFactory;
		const adapter = factory({ accountId });

		// Per-account abort derived from the gateway's parent abort.
		const accountAbort = new AbortController();
		const parent = ctx.signal;
		if (parent) {
			if (parent.aborted) accountAbort.abort();
			else parent.addEventListener("abort", () => accountAbort.abort(), { once: true });
		}

		const pipelineRunTurn: RunChannelTurnFn = (turn) => deps.runTurn(turn);
		// Bundled channel commands so `/help` etc. work on the multi-account path.
		const commandMap = new Map<string, ChannelCommand>();
		for (const c of buildBundledCommands(adapter)) {
			commandMap.set(c.name.toLowerCase(), c);
		}
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
				// Re-read the active config per inbound so policy edits land without
				// restarting the app. Stamp the accountId so the shared pipeline keys
				// ACL + approval-route per account.
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			// Bridge this started adapter to its events-mode webhook route. The route
			// (registered by the module at boot) resolves the sink through this
			// registry at request time, so an event POSTed for THIS workspace's path
			// reaches THIS adapter. Only adapters that carry `feedWebhookEvent` (the
			// real Slack adapter does; a bare test fake may not) are bridged.
			const sinkCapable = adapter as Partial<SlackAdapter>;
			if (typeof sinkCapable.feedWebhookEvent === "function") {
				const feed = sinkCapable.feedWebhookEvent.bind(adapter);
				registerSlackAccountSink(accountId, { feedWebhookEvent: feed });
			}
			// Per-account approval dispatcher — native Block Kit prompt + per-account
			// routing. Without this an exec-gate prompt from a turn on (slack, labs)
			// would fall through to the channel default.
			registerChannelApprovalDispatcher(SLACK_CHANNEL_ID, accountId, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, { ...(opts ?? {}), accountId }),
				prettyName: "Slack",
				approvalCapability: buildApprovalCapability(adapter, accountId),
				getApprovalContext: () => ({ runtime: ctx.runtime, cfg: deps.loadConfig() }),
			});
			log.info("slack account started", { accountId });
		} catch (err) {
			log.warn("slack account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (ctx: ChannelGatewayContext<ResolvedSlackAccount>): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		// Drop the per-account dispatcher + webhook sink BEFORE adapter.stop() so a
		// late in-flight bridge / event POST can't ask a torn-down app to act.
		removeChannelApprovalDispatcher(SLACK_CHANNEL_ID, ctx.accountId);
		removeSlackAccountSink(ctx.accountId);
		try {
			runtime.abort.abort("stop-requested");
		} catch {
			/* best-effort */
		}
		// Clear pending debounce slots so a flush can't fire after stop.
		for (const slot of runtime.pipeline.pendingDispatches.values()) clearTimeout(slot.timer);
		runtime.pipeline.pendingDispatches.clear();
		try {
			await runtime.adapter.stop();
		} catch (err) {
			log.warn("slack account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (ctx: ChannelLogoutContext<ResolvedSlackAccount>): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: SLACK_CHANNEL_ID,
		meta: SLACK_META,
		capabilities: SLACK_CAPABILITIES,
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		probeAccount: async (accountId, cfg) => {
			const token = resolveSlackBotToken(cfg, accountId);
			const result = await probeSlack({ token });
			// Surface the started adapter's liveness signal alongside the auth.test
			// reachability check (observability only — never changes `ok`).
			const live = accountRuntimes.get(accountId)?.adapter as Partial<SlackAdapter> | undefined;
			if (live && typeof live.lastEventAt === "function") {
				return { ...result, lastEventAt: live.lastEventAt() };
			}
			return result;
		},
		config: {
			listAccountIds: (cfg) => listSlackAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveSlackAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => SLACK_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || SLACK_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) {
					return { ok: false, error: `slack account "${accountId}" is not running` };
				}
				try {
					const sent = await runtime.adapter.sendText(params.target.to, params.text, {
						accountId,
						...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
					});
					return {
						ok: true,
						...(sent && typeof sent === "object" && sent.messageId !== undefined
							? { messageId: sent.messageId }
							: {}),
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || SLACK_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `slack account "${accountId}" cannot send media right now` };
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
			sendReaction: async (params) => {
				const accountId = params.target.accountId || SLACK_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.react) {
					return { ok: false, error: `slack account "${accountId}" cannot react right now` };
				}
				try {
					await runtime.adapter.react(params.target.to, params.messageId, params.emoji);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},
		actions: {
			handleAction: async (params) => {
				const accountId = params.accountId || params.target.accountId || SLACK_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.handleAction) {
					return { ok: false, error: `slack account "${accountId}" cannot perform message actions` };
				}
				return runtime.adapter.handleAction({
					conversationId: params.target.to,
					action: params.action,
					accountId,
					...(params.signal ? { signal: params.signal } : {}),
				});
			},
		},
		secrets: {
			secretTargetRegistryEntries: [
				{ path: "channels.slack.botToken", description: "Slack bot token (single-workspace)" },
				{ path: "channels.slack.appToken", description: "Slack app-level token (Socket Mode, single-workspace)" },
				{ path: "channels.slack.signingSecret", description: "Slack signing secret (Events API mode)" },
				{ path: "channels.slack.accounts.*.botToken", description: "Slack bot token (per workspace)" },
				{ path: "channels.slack.accounts.*.appToken", description: "Slack app-level token (per workspace)" },
				{ path: "channels.slack.accounts.*.signingSecret", description: "Slack signing secret (per workspace)" },
			],
		},
	};
}

/** Default adapter factory — threads the per-account scope. */
function defaultSlackAdapterFactory(args: { accountId: string }): ChannelAdapter {
	return createSlackAdapter({ accountId: args.accountId });
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type SlackOutboundTarget = ChannelOutboundTarget;
