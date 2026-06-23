/**
 * `brigade/channel-sdk` — the COMPLETE surface for authoring a Brigade channel.
 *
 * The core `brigade/extension-sdk` carries the base extension contracts
 * (`defineModule` + the capability types). THIS entry point adds the full
 * channel-authoring surface: both the single-account `ChannelAdapter` and the
 * multi-account `ChannelPlugin` contracts, the shared inbound-pipeline /
 * approval-router / backoff / dedupe / media-validation helpers, and the
 * central approval + message-action + durable-seal + webhook capabilities —
 * everything an out-of-tree channel (Slack, Discord, iMessage, …) needs, so it
 * is built ENTIRELY on this barrel without reaching into Brigade internals:
 *
 * ```ts
 * import { defineModule, chunkText, type ChannelAdapter } from "brigade/channel-sdk";
 *
 * export default defineModule({
 *   id: "my-channel",
 *   register(b) {
 *     b.channel(createMyChannelAdapter());
 *   },
 * });
 * ```
 *
 * Re-exports only — zero runtime behaviour of its own — and versioned with the
 * package, so channel authors can rely on it not shifting underneath them.
 */

export * from "./agents/channels/sdk.js";
