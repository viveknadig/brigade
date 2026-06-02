/**
 * `ChannelPlugin<R, P, A>` — the full plugin contract surface.
 *
 * Brand-scrubbed analogue of upstream's `src/channels/plugins/types.plugin.ts`.
 * The shape carries all 28 optional adapter slots; only the eight
 * lifted in `types.adapters.ts` have concrete shapes today. The
 * remaining slots are typed as `unknown` so a channel plugin can declare
 * them now and Step 16+ can tighten the types as the channel manager
 * fans out.
 *
 * Generic parameters:
 *
 *   - `ResolvedAccount` — the channel's per-account state object (e.g.
 *     `{ id, botToken, lastSeenAt, ... }`). Defaults to `unknown`.
 *   - `Probe`           — the payload returned by `status.probeAccount`.
 *   - `Audit`           — the payload returned by `status.auditAccount`.
 *
 * Required slots (every channel must define):
 *   - `id`             — kebab-case canonical channel id.
 *   - `meta`           — user-facing display info.
 *   - `capabilities`   — boolean-flag capability declaration.
 *   - `config`         — `ChannelConfigAdapter` (account discovery).
 *
 * Every other slot is optional. The channel-manager (Step 16) reads
 * `capabilities.<flag>` BEFORE consulting an adapter — a channel with
 * `capabilities.reactions: false` won't have its `outbound.sendReaction`
 * called even if the dispatcher receives a reaction payload.
 */

import type { ChannelId, ChannelMeta, ChannelCapabilities } from "./types.core.js";
import type {
	ChannelApprovalCapability,
	ChannelConfigAdapter,
	ChannelGatewayAdapter,
	ChannelOutboundAdapter,
	ChannelSecurityAdapter,
	ChannelLifecycleAdapter,
	ChannelStatusAdapter,
	ChannelMessageActionAdapter,
	ChannelSecretsAdapter,
} from "./types.adapters.js";

/** Full capability contract for a native channel plugin. */
// oxlint-disable-next-line typescript/no-explicit-any
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
	/* ─── Required ──────────────────────────────────────────────────── */
	id: ChannelId;
	meta: ChannelMeta;
	capabilities: ChannelCapabilities;
	config: ChannelConfigAdapter<ResolvedAccount>;

	/* ─── Core adapters with concrete shapes (lifted in types.adapters.ts) ── */
	gateway?: ChannelGatewayAdapter<ResolvedAccount>;
	outbound?: ChannelOutboundAdapter;
	security?: ChannelSecurityAdapter<ResolvedAccount>;
	lifecycle?: ChannelLifecycleAdapter;
	status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
	actions?: ChannelMessageActionAdapter;
	secrets?: ChannelSecretsAdapter;
	/** Channel-native approval rendering + reply decoding (Step 17). */
	approvalCapability?: ChannelApprovalCapability;

	/* ─── Slots reserved for later steps ────────────────────────────── */
	defaults?: {
		queue?: {
			debounceMs?: number;
		};
	};
	reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
	setupWizard?: unknown;
	configSchema?: unknown;
	setup?: unknown;
	pairing?: unknown;
	groups?: unknown;
	mentions?: unknown;
	gatewayMethods?: string[];
	auth?: unknown;
	elevated?: unknown;
	commands?: unknown;
	allowlist?: unknown;
	doctor?: unknown;
	bindings?: unknown;
	conversationBindings?: unknown;
	streaming?: unknown;
	threading?: unknown;
	messaging?: unknown;
	agentPrompt?: unknown;
	directory?: unknown;
	resolver?: unknown;
	heartbeat?: unknown;
	agentTools?: unknown;
};
