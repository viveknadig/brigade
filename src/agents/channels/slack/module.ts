/**
 * Slack extension module.
 *
 * Registers the Slack channel adapter through the seam. The loader gates it by
 * the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.slack.enabled` is true AND a bot
 * token resolves — so bundling this module is inert until the operator opts in.
 *
 * In EVENTS transport mode (`channels.slack.mode: "events"`) the module ALSO
 * registers a gateway HTTP route PER configured workspace that receives Slack's
 * event POSTs and feeds them into the started adapter for THAT workspace (after
 * verifying the request signature with that workspace's signing secret). Socket
 * mode (the default) registers no HTTP surface. Slack mirror of
 * `telegram/module.ts`, extended for multi-workspace inbound:
 *
 *   - The default account keeps the SAME inline adapter + base path
 *     (`/slack/events`) as the single-workspace path — byte-identical.
 *   - Each NAMED account (only present when >1 account is configured) gets its
 *     own route on a distinct path (`resolveSlackEventsPath`), whose `resolveSink`
 *     looks up THAT account's STARTED adapter at request time via the per-account
 *     adapter registry (`account-registry.ts`) the plugin populates on
 *     `startAccount`. `b.httpRoute(...)` is only available at `register()` time
 *     (before the plugin starts accounts), so the late binding is essential.
 */

import { defineModule } from "../sdk.js";
import {
	listSlackAccountIds,
	resolveSlackEventsPath,
	resolveSlackSigningSecret,
	slackEventsConfig,
	SLACK_DEFAULT_ACCOUNT_ID,
} from "./account-config.js";
import { getSlackAccountSink } from "./account-registry.js";
import { createSlackAdapter, type SlackAdapter } from "./adapter.js";
import { buildSlackWebhookRoute } from "./webhook.js";

export const slackModule = defineModule({
	id: "slack",
	register(b) {
		const adapter = createSlackAdapter() as SlackAdapter;
		b.channel(adapter);
		// Events transport: register the inbound gateway route(s). Gated on config so
		// a Socket Mode (default) install exposes no inbound HTTP surface.
		const transport = slackEventsConfig(b.config as never);
		if (transport.mode !== "events") return;

		const accountIds = listSlackAccountIds(b.config as never);
		// `listSlackAccountIds` returns `["default"]` for a single-workspace install
		// and the named ids for a multi-workspace one. Single → byte-identical to the
		// legacy single-route registration: the default route resolves the inline
		// adapter directly. Multi → one route per workspace, each resolving its
		// account's started adapter via the registry at request time.
		const isMultiWorkspace = accountIds.length > 1;
		for (const accountId of accountIds) {
			const isDefault = accountId === SLACK_DEFAULT_ACCOUNT_ID;
			b.httpRoute(
				buildSlackWebhookRoute({
					// Default account keeps the base path; named accounts get a distinct,
					// collision-free path so two workspaces never share one route.
					path: resolveSlackEventsPath(b.config as never, accountId),
					// Each route verifies with ITS OWN account's signing secret.
					signingSecret: resolveSlackSigningSecret(b.config as never, accountId),
					// The default account in a single-workspace install feeds the inline
					// adapter directly (the legacy adapter owns the default lifecycle).
					// Every other case resolves the per-account started adapter at request
					// time — when the plugin owns the lifecycle the inline adapter steps
					// aside, so we must look up the live one rather than capture it here.
					resolveSink:
						isDefault && !isMultiWorkspace
							? () => adapter
							: () => getSlackAccountSink(accountId) ?? null,
				}),
			);
		}
	},
});
