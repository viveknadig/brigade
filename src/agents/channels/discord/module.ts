/**
 * Discord extension module.
 *
 * Registers the Discord channel adapter through the seam. The loader gates it by
 * the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.discord.enabled` is true AND a bot
 * token resolves — so bundling this module is inert until the operator opts in.
 *
 * Unlike Slack's module, Discord registers NO gateway HTTP route: the Gateway
 * (WebSocket) is the only inbound transport (no public URL needed, analogous to
 * Slack Socket Mode / Telegram long-polling), so there is no events-mode webhook
 * to wire. Discord mirror of `telegram/module.ts` (the polling-only shape).
 */

import { defineModule } from "../sdk.js";
import { createDiscordAdapter } from "./adapter.js";

export const discordModule = defineModule({
	id: "discord",
	register(b) {
		b.channel(createDiscordAdapter());
	},
});
