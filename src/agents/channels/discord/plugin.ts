/**
 * Discord `ChannelPlugin` — the multi-ACCOUNT contract surface.
 *
 * Mirrors `slack/plugin.ts`: wraps `createDiscordAdapter()` (the per-connection
 * implementation) with the lifecycle adapters the `ChannelPluginManager`
 * consumes, so an operator can run MORE THAN ONE Discord bot at once via:
 *
 *   channels.discord = {
 *     enabled: true,
 *     accounts: [
 *       { id: "main", botToken: "…AAA" },
 *       { id: "labs", botToken: "…BBB" },
 *     ],
 *   }
 *
 *   - `config.listAccountIds` / `resolveAccount`  → multi-account discovery
 *   - `gateway.startAccount` / `stopAccount`      → per-account bot lifecycle
 *   - `outbound.sendText` / `sendMedia`           → routes by `target.accountId`
 *   - per-account approval-dispatcher registration → an exec-gate prompt raised
 *     by a turn on (discord, labs) replies on (discord, labs), not the default
 *
 * Per-account state lives in a `Map<accountId, AccountRuntime>` held in this
 * closure — one Gateway connection per account, partitioned token resolution per
 * `channels.discord.accounts[].botToken`. Inbound dispatch reuses the shared
 * `runChannelInboundPipeline` so the multi-account path carries the identical
 * ACL + debounce + abort + approval-reply + approval-callback surface as the
 * legacy single-adapter manager.
 *
 * The legacy single-account `createDiscordAdapter` (started by the legacy
 * `startChannels` manager) STEPS ASIDE when >1 account is configured — its
 * `isConfigured` returns false for the default account in that case (mirrors
 * Slack), so the two paths never double-start a bot.
 *
 * Discord has no events-mode HTTP route (the Gateway is the only inbound
 * transport), so — unlike Slack's plugin — there is NO per-account webhook-sink
 * registry to populate.
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
	DISCORD_CHANNEL_META,
} from "../sdk.js";
import {
	listDiscordAccountIds,
	resolveDiscordAccount,
	resolveDiscordBotToken,
	DISCORD_CHANNEL_ID,
	DISCORD_DEFAULT_ACCOUNT_ID,
	type ResolvedDiscordAccount,
} from "./account-config.js";
import { createDiscordAdapter, DISCORD_CAPABILITIES, type DiscordAdapter } from "./adapter.js";
import { probeDiscord, type DiscordProbeResult } from "./probe.js";
import { auditDiscordChannelPermissions, type DiscordPermissionAuditResult } from "./permission-audit.js";
import { collectDiscordSecurityAuditFindings } from "./security-audit.js";
import { collectDiscordStatusIssues } from "./status-issues.js";

const log = createSubsystemLogger("channels/discord/plugin");

// Single source of truth for the channel's user-facing metadata lives in the
// import-light `bundled-channel-metas` module (re-exported via the SDK barrel),
// so the registry / markdown gate can read it without loading this adapter.
// `DISCORD_CHANNEL_META.id` is the same canonical `"discord"` string as
// `DISCORD_CHANNEL_ID`.
const DISCORD_META = DISCORD_CHANNEL_META;

/** Per-account runtime — one started adapter + a pipeline closure. */
interface AccountRuntime {
	adapter: ChannelAdapter;
	pipeline: InboundPipelineContext;
	abort: AbortController;
}

/** Dependencies the gateway hands the plugin to drive turns + replies. */
export interface DiscordPluginDeps {
	/** Boot-time default agent for routing fallbacks. */
	defaultAgentId: string;
	/** Active gateway config — re-read fresh per inbound for live policy. */
	loadConfig: () => BrigadeConfig;
	/** Run one agent turn (the gateway's serialised turn executor). */
	runTurn: StartChannelsArgs["runTurn"];
	/**
	 * Optional adapter factory — tests inject a fake; production uses
	 * `createDiscordAdapter`. Receives the per-account scope.
	 */
	adapterFactory?: (args: { accountId: string }) => ChannelAdapter;
}

/** Probe result + optional channel-permission audit (Phase 5 diagnostics). */
export type DiscordProbeWithAudit = DiscordProbeResult & {
	/** Channel-permission audit for the configured guild channels, when run. */
	permissionAudit?: DiscordPermissionAuditResult;
};

/** Operator-grade view of a per-account bot — exposed via attached helpers. */
export interface DiscordPluginRuntimeView {
	/** Currently-running account ids. */
	startedAccountIds(): string[];
	/** Look up the per-account adapter (or undefined when the account isn't started). */
	getAdapter(accountId: string): ChannelAdapter | undefined;
	/**
	 * Run a `/users/@me` probe for an account (for status / doctor). Also runs the
	 * channel-permission audit over any configured guild channels (Phase 5).
	 */
	probeAccount(accountId: string, cfg: BrigadeConfig): Promise<DiscordProbeWithAudit>;
}

/**
 * Collect the numeric guild channel ids configured under
 * `channels.discord.guilds.<guildId>.channels.<channelId>` so the permission
 * audit knows which channels to check. Non-numeric keys are passed through too —
 * the audit reports them as unresolved. Returns [] when none are configured.
 */
export function collectConfiguredDiscordChannelIds(cfg: BrigadeConfig): string[] {
	const slot = (cfg as { channels?: Record<string, unknown> }).channels?.[DISCORD_CHANNEL_ID];
	const guilds = slot && typeof slot === "object" ? (slot as Record<string, unknown>).guilds : undefined;
	if (!guilds || typeof guilds !== "object") return [];
	const ids = new Set<string>();
	for (const guildValue of Object.values(guilds as Record<string, unknown>)) {
		if (!guildValue || typeof guildValue !== "object") continue;
		const channels = (guildValue as Record<string, unknown>).channels;
		if (!channels || typeof channels !== "object") continue;
		for (const channelKey of Object.keys(channels as Record<string, unknown>)) {
			const key = channelKey.trim();
			if (key) ids.add(key);
		}
	}
	return [...ids];
}

/** Plugin handle with the extra per-account introspection surface attached. */
export type DiscordPluginHandle = ChannelPlugin<ResolvedDiscordAccount> & DiscordPluginRuntimeView;

/** Build the per-account approval capability — the native component prompt + approver gate. */
function buildApprovalCapability(adapter: ChannelAdapter, accountId: string): ChannelApprovalCapability {
	return {
		async sendApprovalPrompt(params: ChannelApprovalPromptParams): Promise<void> {
			// Delegate to the adapter's own native prompt (component buttons). The
			// adapter throws when the approval id can't be encoded, so the router
			// falls back to its text prompt — mirror that here.
			const cap = adapter.approvalCapability?.sendApprovalPrompt;
			if (!cap) throw new Error("discord adapter has no approval prompt");
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
export function createDiscordPlugin(deps: DiscordPluginDeps): DiscordPluginHandle {
	const accountRuntimes = new Map<string, AccountRuntime>();

	const startAccount = async (ctx: ChannelGatewayContext<ResolvedDiscordAccount>): Promise<void> => {
		const accountId = ctx.accountId || DISCORD_DEFAULT_ACCOUNT_ID;
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
			removeChannelApprovalDispatcher(DISCORD_CHANNEL_ID, accountId);
			accountRuntimes.delete(accountId);
		}

		const cfg = deps.loadConfig();
		const factory = deps.adapterFactory ?? defaultDiscordAdapterFactory;
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
				// restarting the bot. Stamp the accountId so the shared pipeline keys
				// ACL + approval-route per account.
				pipeline.config = deps.loadConfig();
				const stamped: InboundMessage = msg.accountId ? msg : { ...msg, accountId };
				await runChannelInboundPipeline(pipeline, stamped);
			},
		};

		try {
			await adapter.start(startCtx);
			accountRuntimes.set(accountId, { adapter, pipeline, abort: accountAbort });
			// Per-account approval dispatcher — native component prompt + per-account
			// routing. Without this an exec-gate prompt from a turn on (discord, labs)
			// would fall through to the channel default.
			registerChannelApprovalDispatcher(DISCORD_CHANNEL_ID, accountId, {
				sendText: (conversationId, text, opts) =>
					adapter.sendText(conversationId, text, { ...(opts ?? {}), accountId }),
				prettyName: "Discord",
				approvalCapability: buildApprovalCapability(adapter, accountId),
				getApprovalContext: () => ({ runtime: ctx.runtime, cfg: deps.loadConfig() }),
			});
			log.info("discord account started", { accountId });
		} catch (err) {
			log.warn("discord account failed to start", {
				accountId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	};

	const stopAccount = async (ctx: ChannelGatewayContext<ResolvedDiscordAccount>): Promise<void> => {
		const runtime = accountRuntimes.get(ctx.accountId);
		if (!runtime) return;
		accountRuntimes.delete(ctx.accountId);
		// Drop the per-account dispatcher BEFORE adapter.stop() so a late in-flight
		// bridge can't ask a torn-down bot to act.
		removeChannelApprovalDispatcher(DISCORD_CHANNEL_ID, ctx.accountId);
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
			log.warn("discord account stop threw", {
				accountId: ctx.accountId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const logoutAccount = async (ctx: ChannelLogoutContext<ResolvedDiscordAccount>): Promise<ChannelLogoutResult> => {
		try {
			await stopAccount(ctx);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		id: DISCORD_CHANNEL_ID,
		meta: DISCORD_META,
		capabilities: DISCORD_CAPABILITIES,
		startedAccountIds: () => [...accountRuntimes.keys()],
		getAdapter: (accountId: string) => accountRuntimes.get(accountId)?.adapter,
		probeAccount: async (accountId, cfg): Promise<DiscordProbeWithAudit> => {
			const token = resolveDiscordBotToken(cfg, accountId);
			const result = await probeDiscord({ token });
			// Channel-permission audit over any configured guild channels (Phase 5).
			// Best-effort: skipped when the token / probe failed (nothing to check
			// against), or when no channels are configured.
			let permissionAudit: DiscordPermissionAuditResult | undefined;
			const channelIds = collectConfiguredDiscordChannelIds(cfg);
			if (result.ok && token && channelIds.length > 0) {
				try {
					permissionAudit = await auditDiscordChannelPermissions(token, channelIds);
				} catch {
					/* never fail the probe on the audit */
				}
			}
			// Surface the started adapter's liveness signal alongside the /users/@me
			// reachability check (observability only — never changes `ok`).
			const live = accountRuntimes.get(accountId)?.adapter as Partial<DiscordAdapter> | undefined;
			const lastEventAt = live && typeof live.lastEventAt === "function" ? live.lastEventAt() : undefined;
			return {
				...result,
				...(lastEventAt !== undefined ? { lastEventAt } : {}),
				...(permissionAudit ? { permissionAudit } : {}),
			};
		},
		config: {
			listAccountIds: (cfg) => listDiscordAccountIds(cfg),
			resolveAccount: (cfg, accountId) => resolveDiscordAccount(cfg, accountId ?? undefined),
			defaultAccountId: () => DISCORD_DEFAULT_ACCOUNT_ID,
			isEnabled: (account) => account.enabled,
		},
		gateway: {
			startAccount,
			stopAccount,
			logoutAccount,
		},
		outbound: {
			sendText: async (params) => {
				const accountId = params.target.accountId || DISCORD_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime) {
					return { ok: false, error: `discord account "${accountId}" is not running` };
				}
				try {
					const sent = await runtime.adapter.sendText(params.target.to, params.text, {
						accountId,
						...(params.target.threadId !== undefined ? { threadId: params.target.threadId } : {}),
					});
					return {
						ok: true,
						...(sent && typeof sent === "object" && sent.messageId !== undefined ? { messageId: sent.messageId } : {}),
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			sendMedia: async (params) => {
				const accountId = params.target.accountId || DISCORD_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.sendMedia) {
					return { ok: false, error: `discord account "${accountId}" cannot send media right now` };
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
				const accountId = params.target.accountId || DISCORD_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.react) {
					return { ok: false, error: `discord account "${accountId}" cannot react right now` };
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
				const accountId = params.accountId || params.target.accountId || DISCORD_DEFAULT_ACCOUNT_ID;
				const runtime = accountRuntimes.get(accountId);
				if (!runtime || !runtime.adapter.handleAction) {
					return { ok: false, error: `discord account "${accountId}" cannot perform message actions` };
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
				{ path: "channels.discord.botToken", description: "Discord bot token (single-account)" },
				{ path: "channels.discord.accounts.*.botToken", description: "Discord bot token (per account)" },
			],
		},
		// Supplementary security audit (Phase 5): warn on name-based (mutable)
		// allow-list entries. Consumed by `brigade doctor` via the central
		// `channel-security-registry.ts` collector.
		security: {
			collectAuditFindings: (ctx) =>
				collectDiscordSecurityAuditFindings({ cfg: ctx.sourceConfig, accountId: ctx.accountId }),
		},
		// Structured status rollup (Phase 5): intent + permission issues. The
		// central status surface stashes the probe/audit on each account snapshot
		// (under `probe` / `audit`); this adapts those into Discord status issues.
		status: {
			collectStatusIssues: (accounts) =>
				collectDiscordStatusIssues(
					accounts.map((snap) => {
						const s = snap as {
							accountId?: unknown;
							probe?: DiscordProbeWithAudit;
							audit?: DiscordPermissionAuditResult;
						};
						return {
							accountId: typeof s.accountId === "string" ? s.accountId : "",
							...(s.probe ? { probe: s.probe } : {}),
							// The audit may ride on the probe (probeAccount attaches it) or be
							// stashed directly on the snapshot.
							...(s.probe?.permissionAudit
								? { audit: s.probe.permissionAudit }
								: s.audit
									? { audit: s.audit }
									: {}),
						};
					}),
				),
		},
	};
}

/** Default adapter factory — threads the per-account scope. */
function defaultDiscordAdapterFactory(args: { accountId: string }): ChannelAdapter {
	return createDiscordAdapter({ accountId: args.accountId });
}

/** Outbound dispatch helper for callers reaching the plugin directly. */
export type DiscordOutboundTarget = ChannelOutboundTarget;
