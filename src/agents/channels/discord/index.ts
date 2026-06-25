/** Discord channel — public surface. */

export {
	createDiscordAdapter,
	buildReactionNote,
	DISCORD_CAPABILITIES,
	type CreateDiscordAdapterOptions,
	type DiscordAdapter,
} from "./adapter.js";
export {
	listDiscordAccountIds,
	resolveDiscordAccount,
	resolveDiscordAutoThread,
	resolveDiscordBotToken,
	resolveDiscordPresence,
	resolveDiscordProxyUrl,
	discordChannelEnabled,
	discordLiveStreamEnabled,
	discordReactionNotifications,
	discordStreamThrottleMs,
	discordSurfaceReasoning,
	discordThreadIdleTtlMs,
	maskProxyUrl,
	stripBotPrefix,
	DISCORD_BOT_TOKEN_ENV_VAR,
	DISCORD_CHANNEL_ID,
	DISCORD_DEFAULT_ACCOUNT_ID,
	type DiscordAutoThreadNameMode,
	type DiscordPresenceActivityType,
	type DiscordPresenceStatus,
	type DiscordReactionNotificationMode,
	type ResolvedDiscordAccount,
	type ResolvedDiscordAutoThread,
	type ResolvedDiscordPresence,
} from "./account-config.js";
export {
	buildDiscordApprovalMessage,
	buildDiscordApprovalText,
	parseDiscordApprovalAction,
	type DiscordApprovalMessage,
} from "./approval-native.js";
export { resolveDiscordApprover } from "./approval-authorize.js";
export {
	buildDiscordApprovalRows,
	buildDiscordButtonRows,
	sanitizeDiscordCustomId,
	DISCORD_BUTTON_STYLE,
	DISCORD_BUTTONS_PER_ROW,
	DISCORD_CUSTOM_ID_MAX_CHARS,
	DISCORD_MAX_ROWS,
	type DiscordActionRow,
	type DiscordButtonSpec,
} from "./components.js";
export {
	buildDiscordCommandManifest,
	normalizeDiscordCommandName,
	type DiscordApplicationCommand,
} from "./command-menu.js";
export {
	connectDiscord,
	discordBackoffDelay,
	isDiscordUnauthorized,
	redactDiscordToken,
	sanitizeThreadName,
	type ConnectDiscordArgs,
	type DiscordConnection,
	type DiscordInboundMessage,
	type DiscordPresencePayload,
} from "./connection.js";
export {
	downloadDiscordAttachment,
	buildDiscordAttachment,
	isAllowedDiscordAttachmentUrl,
	type DiscordOutboundAttachment,
} from "./media.js";
export { markdownToDiscord, discordTextIsEmpty, DISCORD_MESSAGE_LIMIT } from "./format.js";
export { createDiscordPlugin, type DiscordPluginDeps, type DiscordPluginHandle } from "./plugin.js";
export {
	probeDiscord,
	decodeMessageContentIntent,
	decodePrivilegedIntents,
	MESSAGE_CONTENT_DISABLED_WARNING,
	type DiscordPrivilegedIntents,
	type DiscordProbeResult,
	type DiscordProbeBot,
	type MessageContentIntentState,
	type PrivilegedIntentState,
} from "./probe.js";
export { listDiscordGuilds, type DiscordGuildSummary } from "./guilds.js";
export {
	listDiscordDirectoryPeers,
	listDiscordDirectoryGroups,
	type DiscordDirectoryEntry,
	type DiscordDirectoryQuery,
} from "./directory-live.js";
export {
	auditDiscordChannelPermissions,
	type DiscordChannelPermissionResult,
	type DiscordPermissionAuditResult,
} from "./permission-audit.js";
export { collectDiscordStatusIssues, type DiscordStatusAccount } from "./status-issues.js";
export { collectDiscordSecurityAuditFindings } from "./security-audit.js";
export {
	isDiscordMutableAllowEntry,
	scanDiscordNumericIdHazards,
	type DiscordNumericIdHazard,
} from "./security-doctor.js";
export { collectConfiguredDiscordChannelIds, type DiscordProbeWithAudit } from "./plugin.js";
export { discordModule } from "./module.js";
