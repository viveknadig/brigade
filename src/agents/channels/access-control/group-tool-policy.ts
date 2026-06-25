/**
 * Per-group / per-sender tool policy resolution (channel-agnostic, central).
 *
 * Lets the operator restrict (or expand) which agent tools are available inside a
 * specific group chat — optionally per sender — via config:
 *
 *   channels.<channel>.groups.<groupId> = {
 *     tools: { allow?: string[], alsoAllow?: string[], deny?: string[] },
 *     toolsBySender: {
 *       "id:<senderId>":     { deny: ["exec"] },
 *       "e164:+15555550123": { allow: ["read", "web_search"] },
 *       "username:@alice":   { … },
 *       "name:Alice":        { … },
 *       "*":                 { … }          // wildcard fallback
 *     }
 *   }
 *
 * A `"*"` group key is the per-channel default applied to any group without its
 * own entry. Per-account configs (`channels.<channel>.accounts[].groups`) win over
 * the channel-wide `groups`.
 *
 * NO channel previously resolved per-group tool policy in Brigade, so this is the
 * central implementation (ported from the upstream `resolveChannelGroupToolsPolicy`
 * + `resolveToolsBySender`). Resolution order, highest-priority first:
 *   1. group's `toolsBySender` (sender match)
 *   2. group's `tools`
 *   3. default (`*`) group's `toolsBySender`
 *   4. default (`*`) group's `tools`
 * Returns `undefined` when nothing matches (the turn keeps its normal toolset).
 *
 * Pure / no I/O — the caller passes the loaded config.
 */

/** A resolved tool allow/deny set for a group or sender. */
export interface GroupToolPolicyConfig {
	/** Exact allowlist (when set, only these tools are available). */
	allow?: string[];
	/** Additional allowlist entries merged into `allow`. */
	alsoAllow?: string[];
	/** Tools removed from the effective set (deny wins). */
	deny?: string[];
}

/** Per-sender overrides keyed by `id:`/`e164:`/`username:`/`name:`/`*`. */
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

/** One group's tool-policy config block. */
export interface ChannelGroupToolConfig {
	tools?: GroupToolPolicyConfig;
	toolsBySender?: GroupToolPolicyBySenderConfig;
	[key: string]: unknown;
}

/** Sender identity candidates a per-sender policy can match against. */
export interface GroupToolPolicySender {
	senderId?: string | null;
	senderName?: string | null;
	senderUsername?: string | null;
	senderE164?: string | null;
}

/** The typed key prefixes a `toolsBySender` entry may use. */
const SENDER_KEY_TYPES = ["id", "e164", "username", "name"] as const;
type SenderKeyType = (typeof SENDER_KEY_TYPES)[number];

function lower(value: string): string {
	return value.trim().toLowerCase();
}

/** Parse a typed `toolsBySender` key (`id:…`/`e164:…`/`username:…`/`name:…`). */
function parseTypedSenderKey(rawKey: string): { type: SenderKeyType; value: string } | undefined {
	const trimmed = rawKey.trim();
	if (!trimmed) return undefined;
	const lowered = lower(trimmed);
	for (const type of SENDER_KEY_TYPES) {
		const prefix = `${type}:`;
		if (lowered.startsWith(prefix)) return { type, value: trimmed.slice(prefix.length) };
	}
	return undefined;
}

/** Normalise a sender key for comparison (strip a leading `@` for usernames). */
function normalizeSenderKey(value: string, type: SenderKeyType): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const withoutAt = type === "username" && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	return lower(withoutAt);
}

type Buckets = Record<SenderKeyType, Map<string, GroupToolPolicyConfig>>;

interface CompiledSenderPolicy {
	buckets: Buckets;
	wildcard?: GroupToolPolicyConfig;
}

function compileToolsBySender(toolsBySender: GroupToolPolicyBySenderConfig): CompiledSenderPolicy | undefined {
	const entries = Object.entries(toolsBySender);
	if (entries.length === 0) return undefined;
	const buckets: Buckets = {
		id: new Map(),
		e164: new Map(),
		username: new Map(),
		name: new Map(),
	};
	let wildcard: GroupToolPolicyConfig | undefined;
	for (const [rawKey, policy] of entries) {
		if (!policy) continue;
		const trimmed = rawKey.trim();
		if (!trimmed) continue;
		if (trimmed === "*") {
			wildcard = policy;
			continue;
		}
		const typed = parseTypedSenderKey(trimmed);
		if (typed) {
			const key = normalizeSenderKey(typed.value, typed.type);
			if (key && !buckets[typed.type].has(key)) buckets[typed.type].set(key, policy);
			continue;
		}
		// Backward-compatible fallback: an untyped key matches the sender id only.
		const legacy = normalizeSenderKey(trimmed, "id");
		if (legacy && !buckets.id.has(legacy)) buckets.id.set(legacy, policy);
	}
	return { buckets, wildcard };
}

function matchSenderPolicy(compiled: CompiledSenderPolicy, sender: GroupToolPolicySender): GroupToolPolicyConfig | undefined {
	const idKey = normalizeSenderKey(sender.senderId ?? "", "id");
	if (idKey) {
		const m = compiled.buckets.id.get(idKey);
		if (m) return m;
	}
	const e164Key = normalizeSenderKey(sender.senderE164 ?? "", "e164");
	if (e164Key) {
		const m = compiled.buckets.e164.get(e164Key);
		if (m) return m;
	}
	const userKey = normalizeSenderKey(sender.senderUsername ?? "", "username");
	if (userKey) {
		const m = compiled.buckets.username.get(userKey);
		if (m) return m;
	}
	const nameKey = normalizeSenderKey(sender.senderName ?? "", "name");
	if (nameKey) {
		const m = compiled.buckets.name.get(nameKey);
		if (m) return m;
	}
	return compiled.wildcard;
}

/** Resolve a per-sender tool policy from a `toolsBySender` block, or undefined. */
export function resolveToolsBySender(
	params: { toolsBySender?: GroupToolPolicyBySenderConfig } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
	if (!params.toolsBySender) return undefined;
	const compiled = compileToolsBySender(params.toolsBySender);
	if (!compiled) return undefined;
	return matchSenderPolicy(compiled, params);
}

/** Loose shape of a channel config slot that may carry per-group tool policy. */
interface ChannelToolPolicySlot {
	groups?: Record<string, ChannelGroupToolConfig>;
	accounts?: Array<{ id?: string; groups?: Record<string, ChannelGroupToolConfig> }>;
}

/** Read the `groups` map for a channel (per-account `accounts[].groups` wins). */
function resolveChannelGroups(
	cfg: unknown,
	channel: string,
	accountId?: string | null,
): Record<string, ChannelGroupToolConfig> | undefined {
	const slot = (cfg as { channels?: Record<string, ChannelToolPolicySlot> } | undefined)?.channels?.[channel];
	if (!slot) return undefined;
	const id = (accountId ?? "").trim();
	if (id && id !== "default" && Array.isArray(slot.accounts)) {
		for (const entry of slot.accounts) {
			if (typeof entry?.id === "string" && entry.id.trim() === id && entry.groups) return entry.groups;
		}
	}
	return slot.groups;
}

/** Look a group id up in a `groups` map (exact, then case-insensitive). */
function lookupGroupConfig(
	groups: Record<string, ChannelGroupToolConfig> | undefined,
	groupId: string,
): ChannelGroupToolConfig | undefined {
	if (!groups) return undefined;
	const direct = groups[groupId];
	if (direct) return direct;
	const target = lower(groupId);
	const key = Object.keys(groups).find((k) => k !== "*" && lower(k) === target);
	return key ? groups[key] : undefined;
}

/**
 * Resolve the effective tool policy for an inbound GROUP message — the per-sender
 * override wins over the group's `tools`, which wins over the default (`*`) group.
 * Returns `undefined` when no policy is configured (the turn is unrestricted).
 */
export function resolveChannelGroupToolsPolicy(
	params: {
		cfg: unknown;
		channel: string;
		groupId?: string | null;
		groupIdCandidates?: Array<string | null | undefined>;
		accountId?: string | null;
	} & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
	const groups = resolveChannelGroups(params.cfg, params.channel, params.accountId);
	if (!groups) return undefined;
	const candidates = [params.groupId, ...(Array.isArray(params.groupIdCandidates) ? params.groupIdCandidates : [])];
	let groupConfig: ChannelGroupToolConfig | undefined;
	for (const raw of candidates) {
		const groupId = raw?.trim();
		if (!groupId) continue;
		groupConfig = lookupGroupConfig(groups, groupId);
		if (groupConfig) break;
	}
	const defaultConfig = groups["*"];

	const sender: GroupToolPolicySender = {
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164,
	};

	const groupSenderPolicy = resolveToolsBySender({ toolsBySender: groupConfig?.toolsBySender, ...sender });
	if (groupSenderPolicy) return groupSenderPolicy;
	if (groupConfig?.tools) return groupConfig.tools;
	const defaultSenderPolicy = resolveToolsBySender({ toolsBySender: defaultConfig?.toolsBySender, ...sender });
	if (defaultSenderPolicy) return defaultSenderPolicy;
	if (defaultConfig?.tools) return defaultConfig.tools;
	return undefined;
}
