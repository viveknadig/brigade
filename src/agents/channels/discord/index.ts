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
	resolveDiscordBotToken,
	resolveDiscordProxyUrl,
	discordChannelEnabled,
	discordLiveStreamEnabled,
	discordStreamThrottleMs,
	discordSurfaceReasoning,
	discordThreadIdleTtlMs,
	maskProxyUrl,
	stripBotPrefix,
	DISCORD_BOT_TOKEN_ENV_VAR,
	DISCORD_CHANNEL_ID,
	DISCORD_DEFAULT_ACCOUNT_ID,
	type ResolvedDiscordAccount,
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
	type ConnectDiscordArgs,
	type DiscordConnection,
	type DiscordInboundMessage,
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
	MESSAGE_CONTENT_DISABLED_WARNING,
	type DiscordProbeResult,
	type DiscordProbeBot,
	type MessageContentIntentState,
} from "./probe.js";
export { discordModule } from "./module.js";
