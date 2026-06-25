/**
 * `discord_action` — owner-only Discord guild action surface (Phase 4).
 *
 * Brigade's live Discord adapter handles inbound + the everyday send/edit/react
 * path, but it does NOT expose the wide guild-management surface a full Discord
 * bot needs: creating/editing channels + categories, role + member management, emoji /
 * sticker / scheduled-event admin, rich embeds + polls + stickers + threads +
 * search, and moderation (ban / unban / kick / timeout). This tool fills that
 * gap with a SELF-CONTAINED Discord REST v10 client — exactly like `probe.ts`
 * and Slack's `directory-live.ts`: it resolves the bot token via
 * `resolveDiscordBotToken` and talks straight to `https://discord.com/api/v10`
 * with `Authorization: Bot <token>`. It never reaches through the live
 * adapter/connection, so it works the same whether or not the Gateway socket is
 * up.
 *
 * One meta-tool with an `action` discriminator (keeps the prompt small) dispatches
 * to the matching helper in `discord/rest-actions.ts`. Owner-only: the standard
 * `wrapOwnerOnlyToolExecution` gate (applied at session-wiring) already refuses
 * non-owner senders and unattended cron turns, so this file does not re-implement
 * auth. The registry only ASSEMBLES this tool when the Discord channel is
 * configured (`channels.discord.enabled`), so a non-Discord install never sees it.
 *
 * Each action validates its required params, calls the REST helper, and returns a
 * compact `jsonResult({ action, ok, … })`. REST failures decode (permissions /
 * 404 / rate-limit / unknown-resource) into an operator-readable message via the
 * `DiscordRestError` carried up from the helper.
 *
 * `set-presence` (Phase 5) is the ONE action that is NOT a REST call: presence
 * is a Gateway (websocket) operation, and this self-contained REST tool holds no
 * live discord.js client handle. The clean path chosen here is CONFIG-WRITE — it
 * persists `channels.discord.presence` via `mutateConfigAtomic`, and the live
 * connection applies that presence on its next (re)connect (it re-reads the
 * resolved presence on every start). This keeps the tool stateless + air-gap-
 * safe and avoids reaching across module boundaries into the running gateway.
 */

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import { mutateConfigAtomic, type BrigadeConfig } from "../../config/io.js";
import {
	DISCORD_DEFAULT_ACCOUNT_ID,
	resolveDiscordBotToken,
} from "../channels/discord/account-config.js";
import {
	DiscordRestError,
	type DiscordEmbedSpec,
	type DiscordRestOptions,
	ban,
	categoryCreate,
	categoryDelete,
	categoryEdit,
	channelCreate,
	channelDelete,
	channelEdit,
	channelMove,
	emojiList,
	emojiUpload,
	eventCreate,
	eventList,
	kick,
	listReactions,
	listThreads,
	memberInfo,
	readMessages,
	removeReaction,
	roleAdd,
	roleInfo,
	roleList,
	roleRemove,
	searchMessages,
	sendEmbed,
	sendMessage,
	sendPoll,
	sendSticker,
	threadCreate,
	timeout,
	unban,
	untimeout,
} from "../channels/discord/rest-actions.js";
import {
	serializeDiscordModalTrigger,
	serializeDiscordSelectRow,
	serializeDiscordV2Message,
	type DiscordBlocksInput,
	type DiscordModalInput,
	type DiscordSelectInput,
} from "../channels/discord/rest-components.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/* ───────────────────────────── params ───────────────────────────── */

const EmbedSpecSchema = Type.Object(
	{
		title: Type.Optional(Type.String({ maxLength: 256 })),
		description: Type.Optional(Type.String({ maxLength: 4096 })),
		color: Type.Optional(Type.Number({ description: "Decimal color int, e.g. 5793266 (0x5865F2)." })),
		url: Type.Optional(Type.String({ maxLength: 2048 })),
		footer: Type.Optional(Type.String({ maxLength: 2048 })),
		image: Type.Optional(Type.String({ description: "Image URL.", maxLength: 2048 })),
		thumbnail: Type.Optional(Type.String({ description: "Thumbnail URL.", maxLength: 2048 })),
		fields: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String({ maxLength: 256 }),
					value: Type.String({ maxLength: 1024 }),
					inline: Type.Optional(Type.Boolean()),
				}),
				{ maxItems: 25 },
			),
		),
	},
	{ additionalProperties: false },
);

/* ── typed interactive-component specs (Fix A1) ── */

/** A structured string-select option. */
const SelectOptionSchema = Type.Object(
	{
		label: Type.String({ maxLength: 100 }),
		value: Type.String({ maxLength: 100 }),
		description: Type.Optional(Type.String({ maxLength: 100 })),
	},
	{ additionalProperties: false },
);

/**
 * A structured select-menu spec. The tool serializes it into a Discord
 * action-row whose `custom_id` carries the general-callback marker, so a press
 * routes through the existing select branch and surfaces the chosen values.
 */
const SelectSpecSchema = Type.Object(
	{
		kind: Type.Union(
			[Type.Literal("string"), Type.Literal("user"), Type.Literal("role"), Type.Literal("channel"), Type.Literal("mentionable")],
			{ description: "Select kind. `string` needs `options`; the entity kinds (user/role/channel/mentionable) don't." },
		),
		customId: Type.String({ description: "App-defined token a press routes back to the agent (general-prefixed automatically).", maxLength: 80 }),
		placeholder: Type.Optional(Type.String({ maxLength: 150 })),
		minValues: Type.Optional(Type.Number({ description: "Min selections (default 1)." })),
		maxValues: Type.Optional(Type.Number({ description: "Max selections (default 1)." })),
		options: Type.Optional(Type.Array(SelectOptionSchema, { maxItems: 25, description: "string-select options (required for kind:string, ≤25)." })),
	},
	{ additionalProperties: false },
);

/** A single modal text-input field. */
const ModalFieldSchema = Type.Object(
	{
		id: Type.String({ description: "Field id — echoed back keying the submitted value.", maxLength: 100 }),
		label: Type.String({ maxLength: 45 }),
		style: Type.Optional(Type.Union([Type.Literal("short"), Type.Literal("paragraph")])),
		required: Type.Optional(Type.Boolean()),
		placeholder: Type.Optional(Type.String({ maxLength: 100 })),
	},
	{ additionalProperties: false },
);

/**
 * A structured modal spec. The tool registers the form in the TTL modal registry
 * and emits a trigger button whose `custom_id` is the `modal:<id>` marker the
 * press-router opens via `showModal`; submitting the form routes back as a turn.
 */
const ModalSpecSchema = Type.Object(
	{
		buttonLabel: Type.String({ description: "Label of the button that opens the form.", maxLength: 80 }),
		title: Type.Optional(Type.String({ description: "Modal heading.", maxLength: 45 })),
		fields: Type.Array(ModalFieldSchema, { minItems: 1, maxItems: 5, description: "1..5 text-input fields." }),
		buttonStyle: Type.Optional(Type.Number({ description: "Trigger button style (1=primary, 2=secondary, 3=success, 4=danger)." })),
	},
	{ additionalProperties: false },
);

/** A Components-V2 layout block (discriminated by `type`). */
const BlockSpecSchema = Type.Union(
	[
		Type.Object({ type: Type.Literal("text"), text: Type.String({ maxLength: 4000 }) }, { additionalProperties: false }),
		Type.Object(
			{
				type: Type.Literal("section"),
				texts: Type.Array(Type.String({ maxLength: 4000 }), { minItems: 1, maxItems: 3 }),
				accessory: Type.Optional(
					Type.Union([
						Type.Object({ kind: Type.Literal("thumbnail"), url: Type.String({ maxLength: 2048 }) }, { additionalProperties: false }),
						Type.Object(
							{
								kind: Type.Literal("button"),
								button: Type.Object(
									{
										label: Type.String({ maxLength: 80 }),
										url: Type.Optional(Type.String({ maxLength: 2048 })),
										customId: Type.Optional(Type.String({ maxLength: 100 })),
										style: Type.Optional(Type.Number()),
									},
									{ additionalProperties: false },
								),
							},
							{ additionalProperties: false },
						),
					]),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				type: Type.Literal("separator"),
				divider: Type.Optional(Type.Boolean()),
				spacing: Type.Optional(Type.Union([Type.Literal("small"), Type.Literal("large")])),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				type: Type.Literal("actions"),
				buttons: Type.Array(
					Type.Object(
						{
							label: Type.String({ maxLength: 80 }),
							url: Type.Optional(Type.String({ maxLength: 2048 })),
							customId: Type.Optional(Type.String({ maxLength: 100 })),
							style: Type.Optional(Type.Number()),
						},
						{ additionalProperties: false },
					),
					{ maxItems: 5 },
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				type: Type.Literal("media-gallery"),
				items: Type.Array(
					Type.Object(
						{ url: Type.String({ maxLength: 2048 }), description: Type.Optional(Type.String({ maxLength: 1024 })), spoiler: Type.Optional(Type.Boolean()) },
						{ additionalProperties: false },
					),
					{ maxItems: 10 },
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ type: Type.Literal("file"), url: Type.String({ description: "An attachment:// ref.", maxLength: 2048 }), spoiler: Type.Optional(Type.Boolean()) },
			{ additionalProperties: false },
		),
	],
	{ description: "A Components-V2 layout block." },
);

/** A structured Components-V2 message spec (container of blocks). */
const BlocksSpecSchema = Type.Object(
	{
		blocks: Type.Array(BlockSpecSchema, { minItems: 1, maxItems: 40, description: "Ordered V2 layout blocks." }),
		accentColor: Type.Optional(Type.Number({ description: "Container accent color (decimal int)." })),
	},
	{ additionalProperties: false },
);

const DiscordActionParams = Type.Object({
	action: Type.Union(
		[
			// messaging / content
			Type.Literal("send"),
			Type.Literal("send-embed"),
			Type.Literal("poll"),
			Type.Literal("sticker"),
			Type.Literal("read-messages"),
			Type.Literal("list-reactions"),
			Type.Literal("remove-reaction"),
			Type.Literal("thread-create"),
			Type.Literal("list-threads"),
			Type.Literal("search-messages"),
			// guild-admin
			Type.Literal("channel-create"),
			Type.Literal("channel-edit"),
			Type.Literal("channel-delete"),
			Type.Literal("channel-move"),
			Type.Literal("category-create"),
			Type.Literal("category-edit"),
			Type.Literal("category-delete"),
			Type.Literal("role-list"),
			Type.Literal("role-add"),
			Type.Literal("role-remove"),
			Type.Literal("role-info"),
			Type.Literal("member-info"),
			Type.Literal("emoji-list"),
			Type.Literal("emoji-upload"),
			Type.Literal("event-list"),
			Type.Literal("event-create"),
			// moderation
			Type.Literal("ban"),
			Type.Literal("unban"),
			Type.Literal("kick"),
			Type.Literal("timeout"),
			Type.Literal("untimeout"),
			// presence (Gateway op — persisted to config, applied on (re)connect)
			Type.Literal("set-presence"),
		],
		{
			description:
				"The Discord guild action to run. Messaging: send, send-embed, poll, sticker, read-messages, list-reactions, remove-reaction, thread-create, list-threads, search-messages. Guild-admin: channel-create/edit/delete/move, category-create/edit/delete, role-list/add/remove/info, member-info, emoji-list/upload, event-list/create. Moderation: ban, unban, kick, timeout, untimeout. Presence: set-presence (persists channels.discord.presence; applied on next (re)connect).",
		},
	),
	accountId: Type.Optional(
		Type.String({ description: "Which Discord bot account to act as (default: the configured default).", maxLength: 64 }),
	),

	// common targets
	to: Type.Optional(
		Type.String({ description: "send/send-embed/poll/sticker target: a channel id, `channel:<id>`, or `user:<id>` to DM a user.", maxLength: 64 }),
	),
	channelId: Type.Optional(Type.String({ description: "Channel id for read/reaction/thread/channel-edit/delete actions.", maxLength: 64 })),
	guildId: Type.Optional(Type.String({ description: "Guild (server) id for guild-admin + moderation + search actions.", maxLength: 64 })),
	userId: Type.Optional(Type.String({ description: "Target user id (member-info / role add-remove / moderation).", maxLength: 64 })),
	messageId: Type.Optional(Type.String({ description: "Target message id (reactions / thread-from-message).", maxLength: 64 })),
	roleId: Type.Optional(Type.String({ description: "Role id (role-add / role-remove).", maxLength: 64 })),
	categoryId: Type.Optional(Type.String({ description: "Category (type-4 channel) id (category-edit / category-delete).", maxLength: 64 })),

	// content
	content: Type.Optional(Type.String({ description: "Message text for send/poll/sticker.", maxLength: 4000 })),
	embed: Type.Optional(EmbedSpecSchema),
	embeds: Type.Optional(Type.Array(EmbedSpecSchema, { maxItems: 10, description: "Rich embeds for send." })),
	components: Type.Optional(Type.Array(Type.Unknown(), { description: "send (power-user): raw Discord component-row JSON, passed through verbatim. Prefer the typed `select` / `modal` / `blocks` params." })),
	select: Type.Optional(SelectSpecSchema),
	modal: Type.Optional(ModalSpecSchema),
	blocks: Type.Optional(BlocksSpecSchema),
	replyTo: Type.Optional(Type.String({ description: "send: message id to reply to.", maxLength: 64 })),
	silent: Type.Optional(Type.Boolean({ description: "send: suppress the @-notification ping." })),

	// poll
	question: Type.Optional(Type.String({ description: "poll question.", maxLength: 300 })),
	answers: Type.Optional(Type.Array(Type.String({ maxLength: 55 }), { maxItems: 10, description: "poll answers (≤10)." })),
	durationHours: Type.Optional(Type.Number({ description: "poll duration in hours (default 24)." })),
	allowMultiselect: Type.Optional(Type.Boolean({ description: "poll: allow selecting multiple answers." })),

	// sticker / emoji
	stickerIds: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 3, description: "sticker: sticker ids to send (≤3)." })),
	emoji: Type.Optional(Type.String({ description: "Reaction emoji — raw unicode, or `name:id` for a custom emoji.", maxLength: 128 })),
	emojiName: Type.Optional(Type.String({ description: "emoji-upload: the new emoji's name.", maxLength: 64 })),
	emojiImage: Type.Optional(Type.String({ description: "emoji-upload: a data URI (data:image/png;base64,…) for the emoji image.", maxLength: 600_000 })),

	// reads / search
	limit: Type.Optional(Type.Number({ description: "read-messages (≤50) / list-reactions (≤50) / search-messages (≤25) cap." })),
	before: Type.Optional(Type.String({ description: "read-messages: fetch messages before this id.", maxLength: 64 })),
	after: Type.Optional(Type.String({ description: "read-messages: fetch messages after this id.", maxLength: 64 })),
	around: Type.Optional(Type.String({ description: "read-messages: fetch messages around this id.", maxLength: 64 })),
	query: Type.Optional(Type.String({ description: "search-messages: the text to search for.", maxLength: 400 })),
	authorId: Type.Optional(Type.String({ description: "search-messages: restrict to this author.", maxLength: 64 })),

	// thread
	name: Type.Optional(Type.String({ description: "Name for channel/category/role-less create + thread-create.", maxLength: 100 })),
	threadType: Type.Optional(Type.Number({ description: "thread-create (standalone): channel type (11=public, 12=private)." })),
	autoArchiveMinutes: Type.Optional(Type.Number({ description: "thread-create: idle minutes before auto-archive (60/1440/4320/10080)." })),

	// channel-create / edit
	channelType: Type.Optional(Type.Number({ description: "channel-create: Discord channel type (0=text, 2=voice, 5=announcement, 15=forum)." })),
	parentId: Type.Optional(Type.String({ description: "channel-create/edit/move: parent category id.", maxLength: 64 })),
	topic: Type.Optional(Type.String({ description: "channel-create/edit: channel topic.", maxLength: 1024 })),
	position: Type.Optional(Type.Number({ description: "Sort position for channel/category create/edit/move." })),
	nsfw: Type.Optional(Type.Boolean({ description: "channel-create/edit: mark NSFW." })),
	rateLimitPerUser: Type.Optional(Type.Number({ description: "channel-edit: slow-mode seconds (0 disables)." })),
	archived: Type.Optional(Type.Boolean({ description: "channel-edit (thread): set archived." })),
	locked: Type.Optional(Type.Boolean({ description: "channel-edit (thread): set locked." })),

	// events
	eventName: Type.Optional(Type.String({ description: "event-create: the event name.", maxLength: 100 })),
	startTime: Type.Optional(Type.String({ description: "event-create: ISO-8601 start time.", maxLength: 40 })),
	endTime: Type.Optional(Type.String({ description: "event-create: ISO-8601 end time (required for external events).", maxLength: 40 })),
	description: Type.Optional(Type.String({ description: "event-create: description.", maxLength: 1000 })),
	location: Type.Optional(Type.String({ description: "event-create (external): physical/virtual location.", maxLength: 100 })),
	entityType: Type.Optional(
		Type.Union([Type.Literal("stage"), Type.Literal("voice"), Type.Literal("external")], {
			description: "event-create: stage / voice (needs channelId) / external (needs location + endTime). Default voice.",
		}),
	),

	// moderation
	reason: Type.Optional(Type.String({ description: "Audit-log reason for the moderation action.", maxLength: 512 })),
	deleteMessageDays: Type.Optional(Type.Number({ description: "ban: purge the user's messages from the last N days (0–7)." })),
	durationMinutes: Type.Optional(Type.Number({ description: "timeout: minutes to silence the member (1–40320 = 28 days)." })),

	// presence (set-presence)
	status: Type.Optional(
		Type.Union(
			[Type.Literal("online"), Type.Literal("idle"), Type.Literal("dnd"), Type.Literal("invisible")],
			{ description: "set-presence: the bot's online dot." },
		),
	),
	activityType: Type.Optional(
		Type.Union(
			[
				Type.Literal("playing"),
				Type.Literal("streaming"),
				Type.Literal("listening"),
				Type.Literal("watching"),
				Type.Literal("custom"),
				Type.Literal("competing"),
			],
			{ description: "set-presence: the activity row kind (custom uses the status state line; streaming uses activityUrl)." },
		),
	),
	activityText: Type.Optional(Type.String({ description: "set-presence: the activity text (the 'Playing …' / status line).", maxLength: 128 })),
	activityUrl: Type.Optional(Type.String({ description: "set-presence (streaming): the Twitch/YouTube stream URL.", maxLength: 512 })),
});

interface DiscordActionResult {
	action: string;
	ok: boolean;
	message: string;
	data?: unknown;
}

const MAX_DATA_CHARS = 12_000;

/** Discord allows at most 5 component (action) rows on a classic message. */
const DISCORD_MAX_COMPONENT_ROWS = 5;

/** Compact a payload so a large list result can't flood the model's context. Pure. */
export function capDiscordData(value: unknown, maxChars = MAX_DATA_CHARS): unknown {
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		return value;
	}
	if (!s || s.length <= maxChars) return value;
	return {
		truncated: true,
		bytes: s.length,
		note: `Result truncated at ${maxChars} chars — narrow the request (a lower limit) and try again.`,
		preview: s.slice(0, maxChars),
	};
}

/* ───────────────────────────── tool factory ───────────────────────────── */

export interface MakeDiscordActionToolOptions {
	/** Inject the resolved bot token (tests). When omitted, resolved from config per call. */
	resolveToken?: (accountId: string) => string;
	/** Inject fetch (tests). Defaults to global fetch in the REST helpers. */
	fetchImpl?: typeof fetch;
	/**
	 * Inject the config mutator (tests). Production uses `mutateConfigAtomic`.
	 * Used by `set-presence`, which persists `channels.discord.presence` so the
	 * live connection applies it on next (re)connect.
	 */
	mutateConfig?: (mutate: (current: BrigadeConfig) => BrigadeConfig) => Promise<BrigadeConfig>;
}

/**
 * Persist a presence block under `channels.discord.presence` (single-account) or
 * `channels.discord.accounts[id].presence` (when the account exists in the
 * accounts list). Returns the written presence object. Pure config edit — the
 * live connection re-reads + applies it on next (re)connect.
 */
function writeDiscordPresence(
	current: BrigadeConfig,
	accountId: string,
	presence: Record<string, unknown>,
): BrigadeConfig {
	const cfg = current as { channels?: Record<string, unknown> };
	const channels = { ...(cfg.channels ?? {}) } as Record<string, unknown>;
	const discord = { ...((channels.discord as Record<string, unknown>) ?? {}) };
	const accounts = Array.isArray(discord.accounts) ? (discord.accounts as Array<Record<string, unknown>>) : undefined;
	const accountEntry = accounts?.find((a) => typeof a?.id === "string" && a.id.trim() === accountId);
	if (accountEntry) {
		// Per-account presence.
		discord.accounts = accounts!.map((a) =>
			a === accountEntry ? { ...a, presence } : a,
		);
	} else {
		// Single-account / top-level presence.
		discord.presence = presence;
	}
	channels.discord = discord;
	return { ...(current as object), channels } as BrigadeConfig;
}

export function makeDiscordActionTool(
	opts: MakeDiscordActionToolOptions = {},
): BrigadeTool<typeof DiscordActionParams, DiscordActionResult> {
	const resolveToken =
		opts.resolveToken ??
		((accountId: string): string => {
			try {
				return resolveDiscordBotToken(loadConfig() as never, accountId);
			} catch {
				return "";
			}
		});

	return {
		name: "discord_action",
		label: "Discord action",
		displaySummary: "managing Discord",
		ownerOnly: true,
		description: [
			"Manage a Discord server over the Discord REST API: post/edit content and run guild administration the everyday chat reply can't.",
			"Messaging: action:send (to a channel id or user:<id> DM — content + optional embeds; interactive `select` / `modal` / `blocks` (Components-V2) specs that the user can press/submit — a press routes back to you as a turn), send-embed (a rich embed), poll, sticker, read-messages, list-reactions, remove-reaction, thread-create, list-threads, search-messages.",
			"Guild-admin: channel-create/edit/delete/move, category-create/edit/delete, role-list/add/remove/info, member-info, emoji-list/upload, event-list/create (scheduled events).",
			"Moderation: ban, unban, kick, timeout, untimeout — Discord enforces the bot's own permissions (a missing-permission error is decoded into a clear hint).",
			"Owner-only. Most actions need ids (guildId / channelId / userId / messageId); the tool reports clearly when one is missing.",
		].join(" "),
		parameters: DiscordActionParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<DiscordActionResult>> => {
			const action = args.action;
			const ok = (message: string, data?: unknown): AgentToolResult<DiscordActionResult> =>
				jsonResult({ action, ok: true, message, ...(data !== undefined ? { data: capDiscordData(data) } : {}) } satisfies DiscordActionResult) as AgentToolResult<DiscordActionResult>;
			const fail = (message: string): AgentToolResult<DiscordActionResult> =>
				jsonResult({ action, ok: false, message } satisfies DiscordActionResult) as AgentToolResult<DiscordActionResult>;

			const accountId = (args.accountId ?? "").trim() || DISCORD_DEFAULT_ACCOUNT_ID;

			// set-presence is a CONFIG write (Gateway op applied on next (re)connect),
			// not a REST call — handle it before the live-token guard since it never
			// touches Discord directly.
			if (action === "set-presence") {
				const status = args.status;
				const activityType = args.activityType;
				const activityText = (args.activityText ?? "").trim();
				const activityUrl = (args.activityUrl ?? "").trim();
				if (!status && !activityType && !activityText) {
					return fail("set-presence requires at least a `status` or an `activityType` + `activityText`.");
				}
				const presence: Record<string, unknown> = {};
				if (status) presence.status = status;
				if (activityType) presence.activityType = activityType;
				if (activityText) presence.activityText = activityText;
				if (activityType === "streaming" && activityUrl) presence.activityUrl = activityUrl;
				const mutate = opts.mutateConfig ?? ((m) => mutateConfigAtomic(m));
				try {
					await mutate((current) => writeDiscordPresence(current, accountId, presence));
				} catch (err) {
					return fail(`set-presence failed to persist config: ${err instanceof Error ? err.message : String(err)}`);
				}
				return ok(
					"Saved Discord presence — it applies on the bot's next (re)connect.",
					presence,
				);
			}

			const token = resolveToken(accountId);
			if (!token) {
				return fail(
					"No Discord bot token is configured — connect the Discord channel first (the token seals via connect_channel / channels.discord.botToken), then retry.",
				);
			}
			const rest: DiscordRestOptions = {
				token,
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
			};

			// Tiny required-param guard → a clean, actionable refusal (no REST round-trip).
			const need = (value: string | undefined, label: string): string | null => {
				const v = (value ?? "").trim();
				return v ? v : null;
			};
			const missing = (label: string) => fail(`${action} requires \`${label}\`.`);

			try {
				switch (action) {
					/* ── messaging / content ── */
					case "send": {
						const to = need(args.to, "to");
						if (!to) return missing("to");

						// Typed interactive components (Fix A1). Each structured spec is
						// serialized into raw Discord component-row JSON carrying the SAME
						// custom_id codecs the press-routing expects; a `blocks` (V2) spec
						// also sets the IsComponentsV2 message flag (text must live in
						// TextDisplay blocks, not plain content). The raw `components`
						// passthrough still works for power users.
						const componentRows: unknown[] = Array.isArray(args.components) ? [...args.components] : [];
						let v2Flags = 0;
						let isV2 = false;
						if (args.modal) {
							const built = serializeDiscordModalTrigger({
								...(args.modal as DiscordModalInput),
								...(accountId ? { accountId } : {}),
							});
							if (!built.ok) return fail(built.error);
							componentRows.push(built.row);
						}
						if (args.select) {
							const built = serializeDiscordSelectRow(args.select as DiscordSelectInput);
							if (!built.ok) return fail(built.error);
							componentRows.push(built.row);
						}
						if (args.blocks) {
							const built = serializeDiscordV2Message(args.blocks as DiscordBlocksInput);
							if (!built.ok) return fail(built.error);
							// A V2 message is its OWN components array + flag — it cannot mix
							// with classic content/embeds/action-rows.
							if (args.content || (Array.isArray(args.embeds) && args.embeds.length > 0) || componentRows.length > 0) {
								return fail("blocks (Components-V2) cannot be combined with content, embeds, or select/modal in one send — send them separately.");
							}
							componentRows.push(...built.components);
							v2Flags = built.flags;
							isV2 = true;
						}
						if (componentRows.length > DISCORD_MAX_COMPONENT_ROWS && !isV2) {
							return fail(`send accepts at most ${DISCORD_MAX_COMPONENT_ROWS} component rows.`);
						}

						const data = await sendMessage(
							{
								to,
								...(args.content && !isV2 ? { content: args.content } : {}),
								...(args.embeds && !isV2 ? { embeds: args.embeds as DiscordEmbedSpec[] } : {}),
								...(componentRows.length > 0 ? { components: componentRows } : {}),
								...(v2Flags ? { flags: v2Flags } : {}),
								...(args.replyTo ? { replyTo: args.replyTo } : {}),
								...(args.silent ? { silent: true } : {}),
							},
							rest,
						);
						return ok(`Sent to ${to}.`, data);
					}
					case "send-embed": {
						const to = need(args.to, "to");
						if (!to) return missing("to");
						if (!args.embed) return missing("embed");
						const data = await sendEmbed(
							{ to, embed: args.embed as DiscordEmbedSpec, ...(args.content ? { content: args.content } : {}) },
							rest,
						);
						return ok(`Sent embed to ${to}.`, data);
					}
					case "poll": {
						const to = need(args.to, "to");
						if (!to) return missing("to");
						const question = need(args.question, "question");
						if (!question) return missing("question");
						if (!Array.isArray(args.answers) || args.answers.length < 1) return missing("answers");
						const data = await sendPoll(
							{
								to,
								question,
								answers: args.answers,
								...(typeof args.durationHours === "number" ? { durationHours: args.durationHours } : {}),
								...(args.allowMultiselect ? { allowMultiselect: true } : {}),
							},
							rest,
						);
						return ok(`Posted a poll to ${to}.`, data);
					}
					case "sticker": {
						const to = need(args.to, "to");
						if (!to) return missing("to");
						if (!Array.isArray(args.stickerIds) || args.stickerIds.length < 1) return missing("stickerIds");
						const data = await sendSticker(
							{ to, stickerIds: args.stickerIds, ...(args.content ? { content: args.content } : {}) },
							rest,
						);
						return ok(`Sent sticker(s) to ${to}.`, data);
					}
					case "read-messages": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const data = await readMessages(
							{
								channelId,
								...(typeof args.limit === "number" ? { limit: args.limit } : {}),
								...(args.before ? { before: args.before } : {}),
								...(args.after ? { after: args.after } : {}),
								...(args.around ? { around: args.around } : {}),
							},
							rest,
						);
						const count = Array.isArray(data) ? data.length : undefined;
						return ok(count !== undefined ? `Fetched ${count} message(s).` : "Fetched messages.", data);
					}
					case "list-reactions": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const messageId = need(args.messageId, "messageId");
						if (!messageId) return missing("messageId");
						const emoji = need(args.emoji, "emoji");
						if (!emoji) return missing("emoji");
						const data = await listReactions(
							{ channelId, messageId, emoji, ...(typeof args.limit === "number" ? { limit: args.limit } : {}) },
							rest,
						);
						return ok("Listed reactions.", data);
					}
					case "remove-reaction": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const messageId = need(args.messageId, "messageId");
						if (!messageId) return missing("messageId");
						const emoji = need(args.emoji, "emoji");
						if (!emoji) return missing("emoji");
						await removeReaction(
							{ channelId, messageId, emoji, ...(args.userId ? { userId: args.userId } : {}) },
							rest,
						);
						return ok("Removed reaction.");
					}
					case "thread-create": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const name = need(args.name, "name");
						if (!name) return missing("name");
						const data = await threadCreate(
							{
								channelId,
								name,
								...(args.messageId ? { messageId: args.messageId } : {}),
								...(typeof args.autoArchiveMinutes === "number" ? { autoArchiveMinutes: args.autoArchiveMinutes } : {}),
								...(typeof args.threadType === "number" ? { type: args.threadType } : {}),
								...(args.content ? { content: args.content } : {}),
							},
							rest,
						);
						return ok(`Created thread "${name}".`, data);
					}
					case "list-threads": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const data = await listThreads({ guildId }, rest);
						return ok("Listed active threads.", data);
					}
					case "search-messages": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const query = need(args.query, "query");
						if (!query) return missing("query");
						const data = await searchMessages(
							{
								guildId,
								query,
								...(args.authorId ? { authorId: args.authorId } : {}),
								...(args.channelId ? { channelId: args.channelId } : {}),
								...(typeof args.limit === "number" ? { limit: args.limit } : {}),
							},
							rest,
						);
						return ok("Searched messages.", data);
					}

					/* ── guild-admin ── */
					case "channel-create": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const name = need(args.name, "name");
						if (!name) return missing("name");
						const data = await channelCreate(
							{
								guildId,
								name,
								...(typeof args.channelType === "number" ? { type: args.channelType } : {}),
								...(args.parentId ? { parentId: args.parentId } : {}),
								...(args.topic ? { topic: args.topic } : {}),
								...(typeof args.position === "number" ? { position: args.position } : {}),
								...(typeof args.nsfw === "boolean" ? { nsfw: args.nsfw } : {}),
							},
							rest,
						);
						return ok(`Created channel "${name}".`, data);
					}
					case "channel-edit": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const data = await channelEdit(
							{
								channelId,
								...(args.name !== undefined ? { name: args.name } : {}),
								...(args.topic !== undefined ? { topic: args.topic } : {}),
								...(typeof args.position === "number" ? { position: args.position } : {}),
								...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
								...(typeof args.nsfw === "boolean" ? { nsfw: args.nsfw } : {}),
								...(typeof args.rateLimitPerUser === "number" ? { rateLimitPerUser: args.rateLimitPerUser } : {}),
								...(typeof args.archived === "boolean" ? { archived: args.archived } : {}),
								...(typeof args.locked === "boolean" ? { locked: args.locked } : {}),
							},
							rest,
						);
						return ok("Edited channel.", data);
					}
					case "channel-delete": {
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						const data = await channelDelete({ channelId }, rest);
						return ok("Deleted channel.", data);
					}
					case "channel-move": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const channelId = need(args.channelId, "channelId");
						if (!channelId) return missing("channelId");
						await channelMove(
							{
								guildId,
								channelId,
								...(typeof args.position === "number" ? { position: args.position } : {}),
								...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
							},
							rest,
						);
						return ok("Moved channel.");
					}
					case "category-create": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const name = need(args.name, "name");
						if (!name) return missing("name");
						const data = await categoryCreate(
							{ guildId, name, ...(typeof args.position === "number" ? { position: args.position } : {}) },
							rest,
						);
						return ok(`Created category "${name}".`, data);
					}
					case "category-edit": {
						const categoryId = need(args.categoryId, "categoryId");
						if (!categoryId) return missing("categoryId");
						const data = await categoryEdit(
							{
								categoryId,
								...(args.name !== undefined ? { name: args.name } : {}),
								...(typeof args.position === "number" ? { position: args.position } : {}),
							},
							rest,
						);
						return ok("Edited category.", data);
					}
					case "category-delete": {
						const categoryId = need(args.categoryId, "categoryId");
						if (!categoryId) return missing("categoryId");
						const data = await categoryDelete({ categoryId }, rest);
						return ok("Deleted category.", data);
					}
					case "role-list": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const data = await roleList({ guildId }, rest);
						return ok("Listed roles.", data);
					}
					case "role-info": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const data = await roleInfo({ guildId }, rest);
						return ok("Fetched role info.", data);
					}
					case "role-add": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						const roleId = need(args.roleId, "roleId");
						if (!roleId) return missing("roleId");
						await roleAdd({ guildId, userId, roleId, ...(args.reason ? { reason: args.reason } : {}) }, rest);
						return ok(`Added role ${roleId} to ${userId}.`);
					}
					case "role-remove": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						const roleId = need(args.roleId, "roleId");
						if (!roleId) return missing("roleId");
						await roleRemove({ guildId, userId, roleId, ...(args.reason ? { reason: args.reason } : {}) }, rest);
						return ok(`Removed role ${roleId} from ${userId}.`);
					}
					case "member-info": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						const data = await memberInfo({ guildId, userId }, rest);
						return ok("Fetched member info.", data);
					}
					case "emoji-list": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const data = await emojiList({ guildId }, rest);
						return ok("Listed emojis.", data);
					}
					case "emoji-upload": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const name = need(args.emojiName, "emojiName");
						if (!name) return missing("emojiName");
						const image = need(args.emojiImage, "emojiImage");
						if (!image) return missing("emojiImage");
						const data = await emojiUpload({ guildId, name, image }, rest);
						return ok(`Uploaded emoji "${name}".`, data);
					}
					case "event-list": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const data = await eventList({ guildId }, rest);
						return ok("Listed scheduled events.", data);
					}
					case "event-create": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const name = need(args.eventName, "eventName");
						if (!name) return missing("eventName");
						const startTime = need(args.startTime, "startTime");
						if (!startTime) return missing("startTime");
						const data = await eventCreate(
							{
								guildId,
								name,
								startTime,
								...(args.endTime ? { endTime: args.endTime } : {}),
								...(args.description ? { description: args.description } : {}),
								...(args.channelId ? { channelId: args.channelId } : {}),
								...(args.location ? { location: args.location } : {}),
								...(args.entityType ? { entityType: args.entityType } : {}),
							},
							rest,
						);
						return ok(`Created scheduled event "${name}".`, data);
					}

					/* ── moderation ── */
					case "ban": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						await ban(
							{
								guildId,
								userId,
								...(args.reason ? { reason: args.reason } : {}),
								...(typeof args.deleteMessageDays === "number" ? { deleteMessageDays: args.deleteMessageDays } : {}),
							},
							rest,
						);
						return ok(`Banned ${userId}.`);
					}
					case "unban": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						await unban({ guildId, userId, ...(args.reason ? { reason: args.reason } : {}) }, rest);
						return ok(`Unbanned ${userId}.`);
					}
					case "kick": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						await kick({ guildId, userId, ...(args.reason ? { reason: args.reason } : {}) }, rest);
						return ok(`Kicked ${userId}.`);
					}
					case "timeout": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						if (typeof args.durationMinutes !== "number" || args.durationMinutes <= 0) {
							return fail("timeout requires `durationMinutes` (> 0).");
						}
						await timeout(
							{ guildId, userId, durationMinutes: args.durationMinutes, ...(args.reason ? { reason: args.reason } : {}) },
							rest,
						);
						return ok(`Timed out ${userId} for ${args.durationMinutes} minute(s).`);
					}
					case "untimeout": {
						const guildId = need(args.guildId, "guildId");
						if (!guildId) return missing("guildId");
						const userId = need(args.userId, "userId");
						if (!userId) return missing("userId");
						await untimeout({ guildId, userId, ...(args.reason ? { reason: args.reason } : {}) }, rest);
						return ok(`Cleared timeout for ${userId}.`);
					}

					default:
						return fail(`Unknown action "${String(action)}".`);
				}
			} catch (err) {
				if (err instanceof DiscordRestError) {
					return fail(`Discord ${action} failed: ${err.message}`);
				}
				return fail(`Discord ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}
