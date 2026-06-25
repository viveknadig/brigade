/**
 * iMessage channel — public barrel.
 *
 * Re-exports the channel's public surface (adapter / plugin / config helpers /
 * transport client / send / probe / targets) so the gateway boot + the central
 * registries can import from one place, mirroring `telegram/index.ts` and
 * `discord/index.ts`.
 */

export {
	createIMessageAdapter,
	IMESSAGE_CAPABILITIES,
	type CreateIMessageAdapterOptions,
} from "./adapter.js";
export {
	coerceIMessageChunkMode,
	imessageChannelEnabled,
	imessageThreadIdleTtlMs,
	listIMessageAccountIds,
	normalizeIMessageSelfHandle,
	resolveIMessageAccount,
	resolveIMessageAttachmentRoots,
	resolveIMessageChunkMode,
	resolveIMessageCliPath,
	resolveIMessageDbPath,
	resolveIMessageDefaultTo,
	resolveIMessageDmHistoryLimit,
	resolveIMessageHistoryLimit,
	resolveIMessageIncludeAttachments,
	resolveIMessageProbeTimeoutMs,
	resolveIMessageRemoteAttachmentRoots,
	resolveIMessageRemoteHost,
	resolveIMessageSelfHandle,
	resolveIMessageTextChunkLimit,
	DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
	DEFAULT_IMESSAGE_HISTORY_LIMIT,
	DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
	DEFAULT_IMESSAGE_TEXT_CHUNK_LIMIT,
	IMESSAGE_CHANNEL_ID,
	IMESSAGE_DEFAULT_ACCOUNT_ID,
	IMESSAGE_CLI_PATH_ENV_VAR,
	type IMessageChunkMode,
	type IMessageService,
	type ResolvedIMessageAccount,
} from "./account-config.js";
export {
	createIMessageRpcClient,
	IMessageRpcClient,
	isTestEnv,
	type IMessageRpcLike,
	type IMessageRpcNotification,
	type IMessageRpcClientOptions,
} from "./client.js";
export {
	connectIMessage,
	type ConnectIMessageArgs,
	type IMessageConnection,
	type IMessageInboundMessage,
} from "./connection.js";
export { markdownToIMessageText, sanitizeReplyToId, resolveDeliveredText } from "./format.js";
export {
	resolveOutboundAttachment,
	resolveInboundAttachments,
	resolveInboundAttachmentsRemote,
	kindFromMime,
} from "./media.js";
export { imessageMessagingAdapter } from "./messaging.js";
export {
	createMonitorState,
	decideInbound,
	detectIMessageMentions,
	detectReflectedContent,
	findCodeRegions,
	isInsideCode,
	normalizeIMessageMessage,
	parseIMessageNotification,
	stripLengthPrefixedText,
	LoopRateLimiter,
	SelfChatCache,
	SentMessageCache,
	type IMessagePayload,
	type NormalizedIMessage,
} from "./monitor.js";
export { IMessageHistoryBuffer, renderIMessageHistoryBlock, type IMessageHistoryEntry } from "./history.js";
export {
	detectRemoteHostFromCliPath,
	normalizeScpRemoteHost,
	scpCopyRemoteAttachment,
} from "./remote-attachments.js";
export {
	sanitizeIMessageWatchErrorPayload,
	type SanitizedIMessageWatchErrorPayload,
} from "./watch-error.js";
export { createIMessagePlugin, type IMessagePluginDeps, type IMessagePluginHandle } from "./plugin.js";
export { probeIMessage, probeRpcSupport, type IMessageProbeResult } from "./probe.js";
export { sendMessageIMessage, type IMessageSendOpts, type IMessageSendResult } from "./send.js";
export {
	formatIMessageChatTarget,
	inferIMessageTargetChatType,
	isAllowedIMessageSender,
	normalizeE164,
	normalizeIMessageHandle,
	parseIMessageAllowTarget,
	parseIMessageTarget,
	type IMessageTarget,
	type IMessageAllowTarget,
} from "./targets.js";
export { imessageModule } from "./module.js";
