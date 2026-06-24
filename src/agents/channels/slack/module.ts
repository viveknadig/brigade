/**
 * Slack extension module.
 *
 * Registers the Slack channel adapter through the seam. The loader gates it by
 * the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.slack.enabled` is true AND a bot
 * token resolves — so bundling this module is inert until the operator opts in.
 *
 * In EVENTS transport mode (`channels.slack.mode: "events"`) the module ALSO
 * registers a gateway HTTP route that receives Slack's event POSTs and feeds
 * them into the started adapter (after verifying the request signature). Socket
 * mode (the default) registers no HTTP surface. Slack mirror of
 * `telegram/module.ts`.
 */

import { defineModule } from "../sdk.js";
import { resolveSlackSigningSecret, slackEventsConfig } from "./account-config.js";
import { createSlackAdapter, type SlackAdapter } from "./adapter.js";
import { buildSlackWebhookRoute } from "./webhook.js";

export const slackModule = defineModule({
	id: "slack",
	register(b) {
		const adapter = createSlackAdapter() as SlackAdapter;
		b.channel(adapter);
		// Events transport: register the inbound gateway route. The route resolves
		// the SAME started adapter to feed events into. Gated on config so a Socket
		// Mode (default) install exposes no inbound HTTP surface.
		const transport = slackEventsConfig(b.config as never);
		if (transport.mode === "events") {
			b.httpRoute(
				buildSlackWebhookRoute({
					path: transport.path,
					signingSecret: resolveSlackSigningSecret(b.config as never),
					resolveSink: () => adapter,
				}),
			);
		}
	},
});
