/**
 * Per-account Slack adapter registry — the cross-module bridge that lets the
 * Events-API webhook routes (registered at module `register()` time in
 * `module.ts`) find the per-account adapters that are STARTED later by
 * `createSlackPlugin` (`plugin.ts`).
 *
 * Why this exists. In multi-workspace events mode each account has its OWN
 * inbound webhook path (`/slack/events/<accountId>`). The gateway only accepts
 * `b.httpRoute(...)` registrations during a module's `register()`, but the
 * per-account adapters that those routes must feed are owned by the plugin's
 * `startAccount` lifecycle, which runs AFTER `register()`. So the module
 * registers one route per configured account up front, each route resolving its
 * account's started adapter through THIS registry at request time (a thunk),
 * and the plugin populates the registry on `startAccount` / clears it on
 * `stopAccount`. Same shape + rationale as the channel approval-dispatcher
 * registry (`approval-router.ts`): a process-wide singleton avoids threading the
 * map through the gateway boot, and a single Slack workspace path is unaffected
 * (the legacy single-adapter module owns its own route + adapter directly).
 *
 * Pinned via `resolveGlobalSingleton` so a hot reload / dual-build run shares
 * one map (identical to the approval router).
 */

import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { SLACK_DEFAULT_ACCOUNT_ID } from "./account-config.js";

/** The minimal adapter surface a webhook route needs to feed inbound events. */
export interface SlackAccountSink {
	/** Feed a parsed Slack payload into the started adapter's inbound path. */
	feedWebhookEvent(kind: "event" | "interactive" | "slash", payload: unknown): void;
}

const SLACK_ACCOUNT_SINKS_KEY = Symbol.for("brigade.slack.accountSinks");

/** Keyed by accountId — one started adapter per workspace. */
const sinks = resolveGlobalSingleton<Map<string, SlackAccountSink>>(
	SLACK_ACCOUNT_SINKS_KEY,
	() => new Map<string, SlackAccountSink>(),
);

function normalizeAccountId(accountId: string | null | undefined): string {
	return accountId && accountId.trim() ? accountId.trim() : SLACK_DEFAULT_ACCOUNT_ID;
}

/**
 * Register a started per-account adapter so its events-mode webhook route can
 * feed inbound into it. The plugin calls this on `startAccount`. Idempotent —
 * re-registering replaces the previous entry (restart-friendly).
 */
export function registerSlackAccountSink(accountId: string, sink: SlackAccountSink): void {
	sinks.set(normalizeAccountId(accountId), sink);
}

/**
 * Drop a per-account adapter (the plugin calls this on `stopAccount`) so a
 * torn-down workspace's route can't feed a dead adapter.
 */
export function removeSlackAccountSink(accountId: string): void {
	sinks.delete(normalizeAccountId(accountId));
}

/** Look up a started per-account adapter (or undefined when not started). */
export function getSlackAccountSink(accountId: string): SlackAccountSink | undefined {
	return sinks.get(normalizeAccountId(accountId));
}

/** Diagnostic — the account ids with a live sink. */
export function listSlackAccountSinks(): string[] {
	return [...sinks.keys()];
}

/** Test-only — clear every registered sink. */
export function resetSlackAccountSinksForTests(): void {
	sinks.clear();
}
