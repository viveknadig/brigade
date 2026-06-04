/**
 * Channel slash commands for per-peer agent pinning:
 *
 *   - `/agent <id>`        — pin future messages from THIS peer on THIS
 *                            channel+account to agent `<id>`
 *   - `/agent main`        — clear the peer pin (route falls back to the
 *                            configured default agent)
 *   - `/agent <id> --force` — override an existing pin owned by a different
 *                            agent for the same peer
 *   - `/agents`            — list peer pins on this channel for the sender's
 *                            (channel, account, peer) scope + the default
 *   - `/whoami`            — debug aid: show which agent this peer currently
 *                            routes to + the route tier
 *
 * Wiring: registered via `ChannelCommand` and consumed in
 * `runChannelInboundPipeline` (inbound-pipeline.ts) BEFORE the resolver runs
 * — a successful `/agent` flips the persisted binding and replies with a
 * confirmation, never spawning an agent turn. Future inbound messages from
 * the same (channel, account, peer) triple then land on tier-1
 * (`binding.peer`) of the 8-tier resolver.
 *
 * Brigade-personal-first: no per-user authorize gate (single-operator
 * install — the sender of the message owns the binding). The
 * `ChannelCommandContext.from` field is still recorded as `boundBy` for
 * the future multi-tenant cut.
 *
 * Persistence: every write goes through `mutateConfigAtomic` (the same
 * atomic-write path `brigade agents add` and `agents bind` use), so the
 * on-disk shape stays consistent with what the resolver's per-config
 * WeakMap cache sees. The next inbound message reads the freshly-loaded
 * config (`whatsapp/plugin.ts` calls `deps.loadConfig()` per inbound) and
 * the resolver's cache invalidates automatically because `cfg.bindings`
 * has a new reference identity.
 */

import { resolveDefaultAgentId } from "../agent-scope.js";
import { mutateConfigAtomic } from "../../config/io.js";
import type { BindingEntry, BrigadeConfig } from "../../config/io.js";
import {
	DEFAULT_ACCOUNT_ID,
	normalizeAccountId,
	normalizeAgentId,
} from "../routing/session-key.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
	applyAgentBindings,
	describeBinding,
	listRouteBindings,
	removeAgentBindings,
	type AgentRouteBinding,
} from "../../cli/commands/agents-bindings.js";
import { hasAgentEntry, listAgentEntries } from "../../cli/commands/agents-config.js";
import type { ChannelCommand, ChannelCommandContext } from "../extensions/types.js";
import { handleOrgSnapshot } from "../../core/server-methods/org.js";
import {
	computeExplain,
	filterGraphToSubtree,
	formatExplain,
	parseOrgSlash,
	renderDepartmentsOnly,
} from "../../cli/commands/org-slash.js";
import { renderPrideChartWithPins } from "../org/pride-template.js";

/** Sentinel an operator types to clear the peer pin. */
const MAIN_KEYWORD = "main";

/** Single-token id constraint — anything beyond a single non-empty word is rejected. */
const SIMPLE_AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Build the binding identity used by both the writer and the resolver. The
 * `match` shape mirrors what `agents bind` writes — channel + accountId +
 * peer (kind, id). No guild/team/roles for channel-command pins (those tiers
 * are CLI-only for now).
 */
function buildPeerBindingMatch(
	ctx: ChannelCommandContext,
): NonNullable<BindingEntry["match"]> {
	const accountId = normalizeAccountId(ctx.accountId ?? DEFAULT_ACCOUNT_ID);
	return {
		channel: ctx.channel,
		accountId,
		peer: { kind: ctx.isGroup ? "group" : "direct", id: ctx.from },
	};
}

/**
 * Format the peer label used in confirmation replies.
 * `direct:+15551234567` → `+15551234567`; group ids surface verbatim with
 * a `group:` prefix so the operator can disambiguate.
 */
function formatPeerHint(ctx: ChannelCommandContext): string {
	if (ctx.isGroup) return `group:${ctx.from}`;
	return ctx.from;
}

/**
 * `/agent <id>` handler. Writes a peer-scoped binding (or clears it when
 * `<id>` is `main` / the configured default agent).
 */
async function handleAgentSwitch(ctx: ChannelCommandContext): Promise<string> {
	const tokens = ctx.args
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (tokens.length === 0) {
		return [
			"Usage: /agent <id>",
			"  /agent main          — clear the pin and route to the default crew",
			"  /agent <id> --force  — override an existing pin owned by another agent",
			"Run /agents to list current pins.",
		].join("\n");
	}
	if (tokens.length > 2) {
		return "Usage: /agent <id> [--force]";
	}
	const targetRaw = tokens[0] ?? "";
	const forceFlag = tokens[1] === "--force";
	if (tokens.length === 2 && !forceFlag) {
		return "Usage: /agent <id> [--force]";
	}
	if (!SIMPLE_AGENT_ID_RE.test(targetRaw)) {
		return `Invalid agent id "${targetRaw}". Agent ids are single tokens of letters, digits, '.', '_', or '-'.`;
	}

	const cfg = ctx.config;
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const normalizedTarget = normalizeAgentId(targetRaw);
	const isResetIntent =
		normalizedTarget === MAIN_KEYWORD || normalizedTarget === defaultId;

	const peerMatch = buildPeerBindingMatch(ctx);
	const peerHint = formatPeerHint(ctx);

	// (a) Reset path — clear ANY peer pin for this (channel, account, peer).
	if (isResetIntent) {
		const removeBinding: AgentRouteBinding = {
			agentId: "__placeholder__",
			match: peerMatch,
		};
		const existingForPeer = listRouteBindings(cfg).filter(
			(b) =>
				b.match?.channel === peerMatch.channel &&
				(normalizeAccountId(b.match?.accountId ?? DEFAULT_ACCOUNT_ID) ===
					peerMatch.accountId) &&
				b.match?.peer?.id === peerMatch.peer?.id &&
				b.match?.peer?.kind === peerMatch.peer?.kind,
		);
		if (existingForPeer.length === 0) {
			return `No pin to clear for ${peerHint} — already routing to the default crew (${defaultId}).`;
		}
		// Re-target the placeholder agent id at the existing owner so
		// `removeAgentBindings` matches.
		removeBinding.agentId = existingForPeer[0]?.agentId ?? defaultId;
		await mutateConfigAtomic((cur) => {
			const owners = listRouteBindings(cur as BrigadeConfig).filter(
				(b) =>
					b.match?.channel === peerMatch.channel &&
					normalizeAccountId(b.match?.accountId ?? DEFAULT_ACCOUNT_ID) ===
						peerMatch.accountId &&
					b.match?.peer?.id === peerMatch.peer?.id &&
					b.match?.peer?.kind === peerMatch.peer?.kind,
			);
			let next = cur as BrigadeConfig;
			for (const owner of owners) {
				const remove = removeAgentBindings(next, [
					{ agentId: owner.agentId, match: peerMatch },
				]);
				next = remove.config;
			}
			return next as unknown as typeof cur;
		});
		return `Reset — future messages from ${peerHint} route to the default crew (${defaultId}).`;
	}

	// (b) Pin path — validate target agent exists, then upsert binding.
	if (!hasAgentEntry(cfg, normalizedTarget)) {
		const knownIds = listAgentEntries(cfg).map((e) => normalizeAgentId(e.id));
		const knownStr = knownIds.length > 0 ? knownIds.join(", ") : "(none configured)";
		return `Unknown agent "${targetRaw}". Crew: ${knownStr}. Run /agents to see pins.`;
	}

	const incoming: AgentRouteBinding = {
		agentId: normalizedTarget,
		match: {
			...peerMatch,
			boundBy: ctx.from,
			boundAt: new Date().toISOString(),
			source: "channel-command",
		},
	};

	const result = applyAgentBindings(cfg, [incoming]);
	if (result.conflicts.length > 0 && !forceFlag) {
		const c = result.conflicts[0];
		const existingOwner = c ? c.existingAgentId : "(unknown)";
		return [
			`Refusing to pin ${peerHint} → agent:${normalizedTarget}: already pinned to agent:${existingOwner}.`,
			`Run /agent ${normalizedTarget} --force to override.`,
		].join("\n");
	}

	// Force path — remove the conflicting binding first, then re-apply.
	let overrideNote = "";
	await mutateConfigAtomic((cur) => {
		let next = cur as BrigadeConfig;
		if (forceFlag && result.conflicts.length > 0) {
			for (const conflict of result.conflicts) {
				const owner = conflict.existingAgentId;
				overrideNote = ` (overrode previous pin to agent:${owner})`;
				const remove = removeAgentBindings(next, [
					{ agentId: owner, match: peerMatch },
				]);
				next = remove.config;
			}
		}
		const apply = applyAgentBindings(next, [incoming]);
		next = apply.config;
		return next as unknown as typeof cur;
	});
	if (result.added.length === 0 && result.updated.length === 0 && !forceFlag) {
		// Same agent already pinned — surface idempotent confirmation.
		return `Already pinned ${peerHint} → agent:${normalizedTarget}. No change.`;
	}
	return `Pinned ${peerHint} → agent:${normalizedTarget}${overrideNote}. Tier: binding.peer.`;
}

/**
 * `/agents` handler — list peer pins for this channel + the configured
 * default. Lists ALL pins on this channel (across accounts) so a multi-
 * account install surfaces all of them; the sender's account is highlighted.
 */
function handleAgentsList(ctx: ChannelCommandContext): string {
	const cfg = ctx.config;
	const accountId = normalizeAccountId(ctx.accountId ?? DEFAULT_ACCOUNT_ID);
	const channelBindings = listRouteBindings(cfg).filter(
		(b) => b.match?.channel === ctx.channel && b.match?.peer?.id,
	);
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	if (channelBindings.length === 0) {
		return [
			`No pins on ${ctx.channel}.`,
			`default: agent:${defaultId}`,
		].join("\n");
	}
	const lines: string[] = [`Pins on ${ctx.channel}:`];
	for (const b of channelBindings) {
		const m = b.match ?? {};
		const peer = m.peer ?? {};
		const peerLabel = `peer=${peer.kind ?? ""}:${peer.id ?? ""}`;
		const acct = `account=${normalizeAccountId(m.accountId ?? DEFAULT_ACCOUNT_ID)}`;
		const provenanceParts: string[] = [];
		if (m.boundBy) provenanceParts.push(`pinned by ${m.boundBy}`);
		if (m.boundAt) provenanceParts.push(`at ${m.boundAt}`);
		const provenance =
			provenanceParts.length > 0 ? `  ${provenanceParts.join(" ")}` : "";
		const isMine =
			normalizeAccountId(m.accountId ?? DEFAULT_ACCOUNT_ID) === accountId &&
			peer.id === ctx.from;
		const marker = isMine ? "*" : "-";
		lines.push(
			`  ${marker} agent:${normalizeAgentId(b.agentId)}  ${peerLabel}  ${acct}${provenance}`,
		);
	}
	lines.push(`default: agent:${defaultId}`);
	return lines.join("\n");
}

/**
 * `/whoami` handler — resolve the agent THIS peer is currently routing to
 * and the matched tier. Useful when an operator wants to confirm a `/agent`
 * pin took effect, or to see which tier of the 8-tier resolver claimed
 * their peer (e.g. binding.peer vs binding.channel vs default).
 */
function handleWhoAmI(ctx: ChannelCommandContext): string {
	const cfg = ctx.config;
	const accountId = normalizeAccountId(ctx.accountId ?? DEFAULT_ACCOUNT_ID);
	const route = resolveAgentRoute({
		cfg,
		channel: ctx.channel,
		accountId,
		peer: {
			kind: ctx.isGroup ? "group" : "direct",
			id: ctx.from,
		},
	});
	const peerHint = formatPeerHint(ctx);
	return [
		`Peer:    ${peerHint}`,
		`Channel: ${ctx.channel}`,
		`Account: ${accountId}`,
		`Agent:   ${route.agentId}`,
		`Tier:    ${route.matchedBy}`,
	].join("\n");
}

/**
 * `/org` channel handler — render the Pride chart for the current crew.
 *
 * Forms (mirrors the TUI `/org` slash command — same parser, same
 * filters, same template):
 *
 *   /org                       → full chart
 *   /org <agent-id>            → subtree rooted at <agent-id>
 *   /org --departments         → departments-only (skip Higher Office)
 *   /org --explain <from> <to> → why this edge exists (or doesn't)
 *
 * When `cfg.org` is absent the redirect note is returned UN-wrapped (no
 * code block) — the redirect is prose, not a chart, and wrapping it in
 * monospace makes it harder to read on mobile.
 */
function handleOrg(ctx: ChannelCommandContext): string {
	const parsed = parseOrgSlash(ctx.args);
	if (parsed.kind === "error") return parsed.message;

	const snap = handleOrgSnapshot(undefined, {
		loadConfig: () => ctx.config as never,
	});
	if (snap.ok === false) return snap.redirect;

	// Explain — uses the snapshot graph directly, plain text reply (no
	// code-block wrap, the chain is short and reads cleaner inline).
	if (parsed.kind === "explain") {
		const outcome = computeExplain(snap.graph, parsed.from, parsed.to);
		return formatExplain(outcome);
	}

	const pins = (ctx.config as { org?: { departmentHeads?: Record<string, string> } }).org
		?.departmentHeads;

	// Show — happy path. Use the pre-rendered channel chart from the
	// snapshot so the byte-for-byte shape matches what every other
	// caller sees.
	if (parsed.kind === "show") {
		return snap.charts.channel;
	}

	// Sub-tree — filter the graph then re-render via the SAME template
	// engine (emoji on, ANSI off, triple-backtick wrap).
	if (parsed.kind === "subtree") {
		const filtered = filterGraphToSubtree(snap.graph, parsed.agentId);
		if (!filtered) {
			return `Unknown agent "${parsed.agentId}". Run /org to see the full chart.`;
		}
		const inner = renderPrideChartWithPins(filtered, pins, {
			emoji: true,
			ansi: false,
		});
		return ["```", inner, "```"].join("\n");
	}

	// Departments-only — render the chart with the Higher Office block
	// elided. Re-uses the same template engine + monospace wrap.
	const inner = renderDepartmentsOnly(snap.graph, pins, {
		emoji: true,
		ansi: false,
	});
	return ["```", inner, "```"].join("\n");
}

/**
 * Build the channel `ChannelCommand` entries (`/agent`, `/agents`,
 * `/whoami`, `/org`) with no external dependency — the handlers read
 * everything they need from `ChannelCommandContext` (which already carries
 * `config` + the sender identity). The returned commands plug straight
 * into the channel manager's command map alongside `/help` / `/status`
 * / `/allowlist`.
 *
 * Keeping the factory shape (rather than exporting bare constants) gives
 * the wiring layer a single place to inject test stubs later (e.g. a fake
 * `mutateConfigAtomic` for golden-path tests) and matches `buildBundledCommands`
 * in `inbound-pipeline.ts`.
 */
export function buildAgentSwitchCommands(): ChannelCommand[] {
	return [
		{
			name: "agent",
			description: "Pin future messages from this peer to a specific agent.",
			handler: (ctx) => handleAgentSwitch(ctx),
		},
		{
			name: "agents",
			description: "List peer pins on this channel.",
			handler: (ctx) => handleAgentsList(ctx),
		},
		{
			name: "whoami",
			description: "Show which agent this peer currently routes to.",
			handler: (ctx) => handleWhoAmI(ctx),
		},
		{
			name: "org",
			description:
				"Show the Pride hierarchy chart (or a sub-tree / explain).",
			handler: (ctx) => handleOrg(ctx),
		},
	];
}

/** Re-exported for tests + the inbound-pipeline describeBinding helper. */
export { describeBinding };
