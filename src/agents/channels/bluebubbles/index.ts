/**
 * BlueBubbles channel — public barrel.
 *
 * Re-exports the channel's public surface (adapter, plugin, config resolvers,
 * probe, webhook builders, the module) so the gateway boot + central registries
 * import from one place.
 */

export {
	bluebubblesChannelEnabled,
	listBlueBubblesAccountIds,
	resolveBlueBubblesAccount,
	resolveBlueBubblesServerUrl,
	resolveBlueBubblesPassword,
	resolveBlueBubblesWebhookPath,
	resolveBlueBubblesProbeTimeoutMs,
	resolveBlueBubblesActions,
	resolveBlueBubblesCatchup,
	bluebubblesThreadIdleTtlMs,
	normalizeBlueBubblesServerUrl,
	BLUEBUBBLES_CHANNEL_ID,
	BLUEBUBBLES_DEFAULT_ACCOUNT_ID,
	BLUEBUBBLES_DEFAULT_WEBHOOK_PATH,
	type ResolvedBlueBubblesAccount,
	type BlueBubblesActionFlags,
} from "./account-config.js";
export { createBlueBubblesAdapter, type BlueBubblesAdapter } from "./adapter.js";
export { createBlueBubblesPlugin, type BlueBubblesPluginHandle, type BlueBubblesPluginDeps } from "./plugin.js";
export { probeBlueBubbles, type BlueBubblesProbeResult } from "./probe.js";
export {
	buildBlueBubblesWebhookRoute,
	verifyBlueBubblesWebhook,
	parseBlueBubblesBody,
	safeEqualToken,
	type BlueBubblesWebhookSink,
} from "./webhook.js";
export { bluebubblesMessagingAdapter } from "./messaging.js";
export { bluebubblesModule } from "./module.js";
export {
	sendBlueBubblesTyping,
	markBlueBubblesChatRead,
	renameBlueBubblesChat,
	addBlueBubblesParticipant,
	removeBlueBubblesParticipant,
	leaveBlueBubblesChat,
	setBlueBubblesGroupIcon,
} from "./chat.js";
export {
	resolveBlueBubblesContactName,
	clearBlueBubblesContactCache,
	type ResolveContactNameArgs,
} from "./contact-names.js";
export {
	runBlueBubblesCatchup,
	type BlueBubblesCatchupConfig,
	type BlueBubblesCatchupSummary,
} from "./catchup.js";
