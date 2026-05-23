/**
 * `brigade channels …` — manage messaging channels (WhatsApp, …).
 *
 * Adapter-agnostic by design: every subcommand resolves the channel adapter
 * through the extension registry, so anything that registers via
 * `b.channel(...)` works automatically — WhatsApp today, more later.
 *
 * Discipline: the link/unlink commands TALK TO THE BAILEYS SOCKET DIRECTLY (no
 * gateway round-trip), so the gateway must be stopped before either — two
 * concurrent Baileys sockets to the same WhatsApp number conflict on WhatsApp's
 * side. The commands check and refuse with a clear message if a gateway PID is
 * alive.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import type { ChannelAdapter, ChannelStartContext } from "../../agents/extensions/index.js";
import { addAllowFrom, readAllowFrom, removeAllowFrom } from "../../agents/channels/access-control/index.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir, resolveChannelStateDir } from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { isProcessAlive, readPidFile } from "../../core/gateway-probe.js";

/* ─────────────────────────── helpers ─────────────────────────── */

interface RegistryChannel {
	adapter: ChannelAdapter;
}

/** Load every registered channel adapter (bundled + user-discovered). */
async function loadChannels(): Promise<{ channels: RegistryChannel[]; config: unknown }> {
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
	const registry = await loadModules({
		modules: BUNDLED_MODULES,
		meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
	});
	return { channels: registry.channels.map((adapter) => ({ adapter })), config };
}

function gatewayIsRunning(): boolean {
	const pid = readPidFile();
	return pid != null && isProcessAlive(pid);
}

/** Pick the named channel, or auto-select if there's exactly one. */
function selectChannel(channels: RegistryChannel[], wanted: string | undefined): RegistryChannel | undefined {
	if (wanted) return channels.find((c) => c.adapter.id === wanted);
	if (channels.length === 1) return channels[0];
	return undefined;
}

/** Snapshot of one channel's on-disk + config state (no network). */
interface ChannelSnapshot {
	id: string;
	label: string;
	enabled: boolean; // channels.<id>.enabled in brigade.json
	configured: boolean; // adapter.isConfigured(cfg, env) — usually mirrors `enabled` but adapters can override
	linked: boolean; // auth artifacts present on disk
	stateDir: string; // ~/.brigade/channels/<id>
}

function snapshotChannel(adapter: ChannelAdapter, config: unknown): ChannelSnapshot {
	const cfg = config as { channels?: Record<string, { enabled?: boolean }> };
	const enabled = cfg.channels?.[adapter.id]?.enabled === true;
	let configured = false;
	try {
		configured = adapter.isConfigured(config as never);
	} catch {
		/* adapter shouldn't throw here, but be safe */
	}
	const stateDir = resolveChannelStateDir(adapter.id);
	const linked = hasLinkArtifacts(stateDir);
	return { id: adapter.id, label: adapter.label, enabled, configured, linked, stateDir };
}

/**
 * Read the operator's account id from the channel's auth-store, when one exists.
 * Today this is a Baileys-specific peek (the only channel implemented), but the
 * shape is generic — other channels can grow their own state-file parsers as
 * they land. Returns `undefined` when we can't pull a hint without doing a
 * full link probe (a connect just to read selfId would defeat the whole point
 * of the short-circuit).
 */
function describeExistingLink(channelId: string): { accountHint?: string } | undefined {
	const stateDir = resolveChannelStateDir(channelId);
	if (!hasLinkArtifacts(stateDir)) return undefined;
	// WhatsApp / Baileys: creds live at <stateDir>/auth/creds.json with
	// `me.id` = jid like "15551234567:1@s.whatsapp.net". Strip the device
	// suffix to get the canonical phone digits we display in the success card.
	if (channelId === "whatsapp") {
		const credsPath = path.join(stateDir, "auth", "creds.json");
		if (existsSync(credsPath)) {
			try {
				const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
					me?: { id?: string };
				};
				const jid = creds?.me?.id;
				if (typeof jid === "string" && jid.length > 0) {
					const beforeAt = jid.split("@")[0] ?? jid;
					const beforeColon = beforeAt.split(":")[0] ?? beforeAt;
					const digits = beforeColon.replace(/\D/g, "");
					if (digits.length >= 7) return { accountHint: digits };
				}
			} catch {
				// Corrupted creds.json — still report linked (artifacts present)
				// without a phone hint. The next link/unlink will heal it.
			}
		}
	}
	return {};
}

/** "Looks linked" = the channel's state dir has at least one non-empty file. */
function hasLinkArtifacts(stateDir: string): boolean {
	if (!existsSync(stateDir)) return false;
	const stack = [stateDir];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const p = path.join(dir, name);
			try {
				const st = statSync(p);
				if (st.isFile() && st.size > 0) return true;
				if (st.isDirectory()) stack.push(p);
			} catch {
				/* ignore */
			}
		}
	}
	return false;
}

/** Set `channels.<id>.enabled` in brigade.json (read–modify–write). */
function setChannelEnabled(channelId: string, enabled: boolean): void {
	const cfg = loadConfig() as Record<string, unknown>;
	const channels = (cfg.channels as Record<string, Record<string, unknown>> | undefined) ?? {};
	const entry = channels[channelId] ?? {};
	channels[channelId] = { ...entry, enabled };
	cfg.channels = channels;
	saveConfig(cfg as never);
}

function reportUnknownChannel(channels: RegistryChannel[], wanted: string | undefined): number {
	if (channels.length === 0) {
		process.stderr.write("No channels are bundled or installed.\n");
		return 2;
	}
	if (!wanted) {
		const ids = channels.map((c) => c.adapter.id).join(", ");
		process.stderr.write(`More than one channel is available — pick one with --channel <id> (have: ${ids}).\n`);
		return 2;
	}
	const ids = channels.map((c) => c.adapter.id).join(", ");
	process.stderr.write(`Unknown channel "${wanted}" (have: ${ids}).\n`);
	return 2;
}

/* ─────────────────────────── list ─────────────────────────── */

export async function runChannelsList(opts: { json?: boolean } = {}): Promise<number> {
	const { channels, config } = await loadChannels();
	const rows = channels.map((c) => snapshotChannel(c.adapter, config));
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channels: rows }, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("No channels available. (Try installing one under ~/.brigade/extensions/.)\n");
		return 0;
	}
	const header = `${"ID".padEnd(14)} ${"LABEL".padEnd(16)} ENABLED  LINKED`;
	process.stdout.write(`${header}\n`);
	for (const r of rows) {
		const line = `${r.id.padEnd(14)} ${r.label.padEnd(16)} ${(r.enabled ? "yes" : "no ").padEnd(7)}  ${r.linked ? "yes" : "no"}`;
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

/* ─────────────────────────── status ─────────────────────────── */

export async function runChannelsStatus(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels, config } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const snap = snapshotChannel(chosen.adapter, config);
	const gateway = gatewayIsRunning();
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ...snap, gateway }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${snap.label} (${snap.id})\n`);
	process.stdout.write(`  enabled  : ${snap.enabled ? "yes" : "no"}\n`);
	process.stdout.write(`  configured: ${snap.configured ? "yes" : "no"}\n`);
	process.stdout.write(`  linked   : ${snap.linked ? "yes" : "no"}\n`);
	process.stdout.write(`  authDir  : ${snap.stateDir}\n`);
	process.stdout.write(`  gateway  : ${gateway ? "running" : "stopped"}\n`);
	return 0;
}

/* ─────────────────────────── link ─────────────────────────── */

export async function runChannelsLink(
	args: { channel?: string; timeoutMs?: number },
	opts: { json?: boolean } = {},
): Promise<number> {
	if (gatewayIsRunning()) {
		const msg =
			"The Brigade gateway is running. Stop it first (brigade gateway stop) so it doesn't share the channel socket.";
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}

	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const adapter = chosen.adapter;
	const timeoutMs = args.timeoutMs ?? 180_000;

	// Short-circuit: if the channel already has on-disk creds, don't print a
	// QR + push the operator through a full pair handshake. They probably
	// re-ran `wa:link` to check status or because they forgot they'd done it.
	// Tell them who's currently linked and exit cleanly. To force a fresh QR
	// they can run `wa:unlink` first (or `--force`, plumbed below).
	const existingLinkInfo = describeExistingLink(adapter.id);
	if (existingLinkInfo) {
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, alreadyLinked: true, account: existingLinkInfo.accountHint }, null, 2)}\n`,
			);
		} else {
			process.stdout.write(
				[
					"",
					`ℹ️   ${adapter.label} is already linked`,
					"   ━━━━━━━━━━━━━━━━━━━━━━",
					existingLinkInfo.accountHint
						? `   Connected as: ${formatAccountForDisplay(adapter.id, existingLinkInfo.accountHint)}`
						: "",
					`   Run \`brigade channels unlink --channel ${adapter.id}\` first if you want a fresh QR.`,
					"",
				]
					.filter(Boolean)
					.join("\n") + "\n",
			);
		}
		return 0;
	}

	const abort = new AbortController();
	let connected = false;
	let loggedOut = false;
	let resolveDone: () => void = () => {};
	let rejectDone: (e: Error) => void = () => {};
	const done = new Promise<void>((res, rej) => {
		resolveDone = res;
		rejectDone = rej;
	});

	const onSigint = () => {
		process.stderr.write("\nLink cancelled.\n");
		abort.abort();
		void adapter.stop().catch(() => {});
		process.exit(130);
	};
	process.on("SIGINT", onSigint);

	const timer = setTimeout(() => {
		rejectDone(new Error(`Link timed out after ${Math.round(timeoutMs / 1000)}s.`));
	}, timeoutMs);
	// Deliberately NOT `.unref()` — this timer is the one thing anchoring the
	// Node event loop during the brief window between the post-pair 515 close
	// and the rebuilt socket reaching `open`. Unref'ing both this AND the
	// adapter's reconnect timer (the previous bug) leaves a gap where the loop
	// has nothing to wait on, Node exits early, the success card never prints,
	// and the operator sees "Detected unsettled top-level await" instead.
	// The `process.exit(…)` in the `finally` cleans up if this timer outlives
	// the success path, so anchoring here is safe.

	// Track which logs we render to the user. Adapters emit verbose protocol-
	// level logs (the gateway needs them); the link CLI should stay quiet and
	// let the polished status lines below do the talking. We silently swallow
	// adapter logs and surface them only on failure for diagnostics.
	const swallowedLogs: string[] = [];

	const ctx: ChannelStartContext = {
		signal: abort.signal,
		// One-shot pair: tell the adapter not to chase transient reconnects (the
		// 515 hop that's part of a real pair is still honored). The CLI's outer
		// timeout owns the "user took too long" case.
		linkMode: true,
		log: (msg) => {
			// Buffer for failure diagnostics; do NOT print to the user — the
			// link UX is shaped by the polished lines below.
			swallowedLogs.push(`[${adapter.id}] ${msg}`);
		},
		onLinkProgress: (status) => {
			// Single polished status line during multi-step handshakes (e.g.
			// WhatsApp's post-pair 515 restart). The adapter only emits these
			// in linkMode so the CLI gets the friendly cadence without
			// touching the gateway's structured logs.
			process.stdout.write(`${status}\n`);
		},
		onPairing: (info) => {
			// The adapter has already rendered the QR via qrcode-terminal AND
			// printed the "Scan this QR in WhatsApp → Settings → Linked
			// Devices:" prompt above the code. No second prompt needed here —
			// duplicating it just clutters the screen.
			if (info.kind === "code") {
				process.stdout.write(`\nPairing code: ${info.value}\n`);
			}
		},
		onConnected: () => {
			connected = true;
			resolveDone();
		},
		onLoggedOut: () => {
			loggedOut = true;
			rejectDone(new Error("The channel rejected the link (creds invalid). Try `brigade channels unlink` and retry."));
		},
		// No inbound during link — return resolved if anything arrives.
		onInbound: async () => {},
	};

	let outcome: { ok: boolean; reason?: string };
	let linkedAccount: string | undefined;
	try {
		process.stdout.write(`Linking ${adapter.label}…\n`);
		await adapter.start(ctx);
		await done;
		// Grab the linked account id (digits-only E.164 for WhatsApp; channel-
		// native otherwise) BEFORE we stop the adapter — selfId may be cleared
		// during teardown.
		linkedAccount = adapter.selfId?.();
		outcome = { ok: true };
		// Enable the channel in config so the gateway picks it up on next boot.
		try {
			setChannelEnabled(adapter.id, true);
		} catch (err) {
			process.stderr.write(
				`(warning: linked successfully but failed to update brigade.json: ${err instanceof Error ? err.message : String(err)})\n`,
			);
		}
	} catch (err) {
		outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", onSigint);
		abort.abort();
		try {
			await adapter.stop();
		} catch {
			/* best-effort */
		}
	}

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ...outcome, connected, loggedOut, account: linkedAccount }, null, 2)}\n`,
		);
	} else if (outcome.ok) {
		// Polished success card — matches the welcome-card style so an operator
		// finishing the link gets the same on-brand cadence as a friend going
		// through pairing.
		const accountLine = linkedAccount
			? `   Connected as: ${formatAccountForDisplay(adapter.id, linkedAccount)}\n`
			: "";
		process.stdout.write(
			[
				"",
				`✅  ${adapter.label} linked successfully`,
				"   ━━━━━━━━━━━━━━━━━━━━━━",
				accountLine.trimEnd(),
				"   Run `brigade gateway` to start receiving messages.",
				"",
			]
				.filter(Boolean)
				.join("\n") + "\n",
		);
	} else {
		process.stderr.write(`\nLink failed: ${outcome.reason}\n`);
		// On failure, replay buffered adapter logs so the operator has the
		// protocol-level detail they need to diagnose.
		if (swallowedLogs.length > 0) {
			process.stderr.write("\n--- adapter log ---\n");
			for (const line of swallowedLogs) process.stderr.write(`${line}\n`);
		}
	}
	// Baileys keeps internal keepalive timers + unsettled promise chains alive
	// after `adapter.stop()`; without an explicit exit, Node sees a pending
	// top-level await on the entry shim and emits an "unsettled top-level
	// await" warning while it exits anyway. Exiting cleanly here avoids the
	// warning and matches OpenClaw's link-command behavior (one-shot exit).
	process.exit(outcome.ok ? 0 : 1);
}

/**
 * Render a channel-native account id for the success card.
 * WhatsApp gives us digits-only E.164 — show it as `+15551234567` so it reads
 * like a phone number. Other channels get their id verbatim.
 */
function formatAccountForDisplay(channelId: string, accountId: string): string {
	if (channelId === "whatsapp" && /^\d{7,15}$/.test(accountId)) {
		return `+${accountId}`;
	}
	return accountId;
}

/* ─────────────────────────── unlink ─────────────────────────── */

export async function runChannelsUnlink(
	args: { channel?: string; yes?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	if (gatewayIsRunning()) {
		const msg = "The Brigade gateway is running. Stop it first (brigade gateway stop) before unlinking.";
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`${msg}\n`);
		return 1;
	}
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const id = chosen.adapter.id;
	const dir = resolveChannelStateDir(id);

	if (!args.yes && process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = (await rl.question(`Delete ${dir} and disable ${id}? [y/N] `)).trim().toLowerCase();
			if (answer !== "y" && answer !== "yes") {
				process.stderr.write("Cancelled.\n");
				return 1;
			}
		} finally {
			rl.close();
		}
	}

	try {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to remove ${dir}: ${msg}\n`);
		return 1;
	}
	try {
		setChannelEnabled(id, false);
	} catch {
		/* config update is best-effort — the on-disk wipe is the source of truth */
	}
	if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
	else process.stdout.write(`${chosen.adapter.label} unlinked. Re-run \`brigade channels link\` to scan a new code.\n`);
	return 0;
}

/* ─────────────────────────── enable / disable ─────────────────────────── */

async function setEnableFlag(channel: string | undefined, enabled: boolean, json: boolean | undefined): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, channel);
	if (!chosen) return reportUnknownChannel(channels, channel);
	try {
		setChannelEnabled(chosen.adapter.id, enabled);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to update brigade.json: ${msg}\n`);
		return 1;
	}
	const verb = enabled ? "enabled" : "disabled";
	if (json) process.stdout.write(`${JSON.stringify({ ok: true, channel: chosen.adapter.id, enabled })}\n`);
	else process.stdout.write(`${chosen.adapter.label} ${verb}.\n`);
	return 0;
}

export const runChannelsEnable = (args: { channel?: string }, opts: { json?: boolean } = {}) =>
	setEnableFlag(args.channel, true, opts.json);
export const runChannelsDisable = (args: { channel?: string }, opts: { json?: boolean } = {}) =>
	setEnableFlag(args.channel, false, opts.json);

/* ─────────────────────────── add (non-interactive provisioning) ─────────────────────────── */

/**
 * Non-interactive provisioning for a token-based channel (Slack/Telegram/Discord
 * pattern — WhatsApp uses QR via `link`). Writes `channels.<id>` in brigade.json
 * with `enabled: true` plus any `--token`, `--account`, and free-form `--set k=v`
 * key/value pairs. Useful for CI / config-as-code; the operator never has to
 * paste a secret into a TUI.
 */
export async function runChannelsAdd(
	args: { channel: string; token?: string; account?: string; set?: string[] },
	opts: { json?: boolean } = {},
): Promise<number> {
	const id = args.channel.trim();
	if (!id) {
		process.stderr.write("--channel <id> is required.\n");
		return 2;
	}
	const cfg = loadConfig() as Record<string, unknown>;
	const channels = (cfg.channels as Record<string, Record<string, unknown>> | undefined) ?? {};
	const entry = { ...(channels[id] ?? {}) } as Record<string, unknown>;
	entry.enabled = true;
	if (args.token) entry.token = args.token;
	if (args.account) entry.accountId = args.account;
	for (const kv of args.set ?? []) {
		const eq = kv.indexOf("=");
		if (eq === -1) {
			process.stderr.write(`--set entry must be "key=value" (got ${JSON.stringify(kv)}).\n`);
			return 2;
		}
		const key = kv.slice(0, eq).trim();
		const rawValue = kv.slice(eq + 1);
		// Try JSON5-style parse so booleans/numbers/objects work; fall back to raw.
		let parsed: unknown = rawValue;
		try {
			parsed = JSON.parse(rawValue);
		} catch {
			/* keep as string */
		}
		if (key) entry[key] = parsed;
	}
	channels[id] = entry;
	cfg.channels = channels;
	try {
		saveConfig(cfg as never);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: msg })}\n`);
		else process.stderr.write(`Failed to write brigade.json: ${msg}\n`);
		return 1;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, channel: id, fields: Object.keys(entry) })}\n`);
	} else {
		process.stdout.write(`Provisioned ${id} (enabled${args.token ? ", token set" : ""}).\n`);
	}
	return 0;
}

/* ─────────────────────────── allow list / add / remove ─────────────────────────── */

export async function runChannelsAllowList(
	args: { channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const allow = readAllowFrom(chosen.adapter.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ channel: chosen.adapter.id, allowFrom: allow }, null, 2)}\n`);
		return 0;
	}
	if (allow.length === 0) {
		process.stdout.write(`No senders are on ${chosen.adapter.id}'s allow-from list yet.\n`);
		return 0;
	}
	process.stdout.write(`${chosen.adapter.label} allow-from (${allow.length}):\n`);
	for (const id of allow) process.stdout.write(`  ${id}\n`);
	return 0;
}

export async function runChannelsAllowAdd(
	args: { id: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const added = addAllowFrom(chosen.adapter.id, args.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, channel: chosen.adapter.id, added, id: args.id })}\n`);
	} else if (added) {
		process.stdout.write(`Added "${args.id}" to ${chosen.adapter.label}'s allow-from list.\n`);
	} else {
		process.stdout.write(`"${args.id}" was already on ${chosen.adapter.label}'s allow-from list.\n`);
	}
	return 0;
}

export async function runChannelsAllowRemove(
	args: { id: string; channel?: string },
	opts: { json?: boolean } = {},
): Promise<number> {
	const { channels } = await loadChannels();
	const chosen = selectChannel(channels, args.channel);
	if (!chosen) return reportUnknownChannel(channels, args.channel);
	const removed = removeAllowFrom(chosen.adapter.id, args.id);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: removed, channel: chosen.adapter.id, id: args.id })}\n`);
	} else if (removed) {
		process.stdout.write(`Removed "${args.id}" from ${chosen.adapter.label}'s allow-from list.\n`);
	} else {
		process.stderr.write(`"${args.id}" was not on ${chosen.adapter.label}'s allow-from list.\n`);
	}
	return removed ? 0 : 1; // exit code reflects the action, regardless of output mode
}
