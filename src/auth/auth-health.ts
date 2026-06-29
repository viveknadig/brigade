/**
 * Auth health — detect subscription credentials that CANNOT auto-refresh and
 * will eventually 401 (the silent "gateway disconnected after a day or two"
 * failure the operator hit).
 *
 * A subscription login is self-healing ONLY when stored as a proper OAuth
 * credential WITH a refresh token: Pi refreshes the rotating access token and
 * `auth-bridge` persists it (see core/auth-bridge.ts). These do NOT self-heal:
 *   - type "token"   — a bare access token (no refresh), e.g. a CLI login that
 *                      lacked a refresh token.
 *   - type "api_key" holding an `sk-ant-oat…` subscription access token (pasted
 *                      or written by an older onboarding path).
 *   - type "oauth"   with no refresh token.
 * The fix in every case is `brigade login` (browser OAuth → refresh token).
 *
 * Reads through the mode-aware `readProfiles` choke point, so it is correct in
 * BOTH filesystem and Convex mode (it never touches a raw file or the store
 * adapter directly).
 */

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { PROVIDERS } from "../providers/catalog.js";
import { readProfiles } from "./profiles.js";

export interface UnrefreshableSubscription {
	/** Stored provider id (where the credential lives, e.g. "anthropic"). */
	provider: string;
	/** Friendly provider name (e.g. "Claude Code"). */
	label: string;
	/** Why it can't refresh. */
	reason: string;
}

/** The minimal profile shape the classifier inspects. */
export interface RefreshScanProfile {
	type?: string;
	key?: string;
	access?: string;
	refresh?: string;
	refreshRef?: unknown;
	token?: string;
}

/**
 * Classify whether a stored profile can auto-refresh. Returns the human reason
 * it CAN'T (for warnings), or null when the credential is healthy. Pure — unit
 * testable without any storage.
 */
export function classifySubscriptionRefresh(prof: RefreshScanProfile): string | null {
	if (prof.type === "token" || (!prof.type && typeof prof.token === "string" && prof.token.length > 0)) {
		return "stored as a one-time token with no refresh token";
	}
	if (prof.type === "oauth") {
		const hasRefresh =
			(typeof prof.refresh === "string" && prof.refresh.length > 0) || prof.refreshRef != null;
		return hasRefresh ? null : "OAuth login is missing its refresh token";
	}
	if (prof.type === "api_key") {
		// A subscription ACCESS token (sk-ant-oat…) pasted as a static key expires
		// and can't refresh. A real API key (sk-ant-api…) doesn't expire — fine.
		if (typeof prof.key === "string" && prof.key.startsWith("sk-ant-oat")) {
			return "a subscription token is stored as a static key — it expires and can't refresh";
		}
		return null;
	}
	return null;
}

/**
 * Scan stored auth profiles for subscription credentials that can't auto-refresh.
 * One entry per affected subscription provider; empty = all healthy (or none).
 * Mode-aware (fs + Convex) via `readProfiles`.
 */
export function detectUnrefreshableSubscriptions(
	agentId: string = DEFAULT_AGENT_ID,
): UnrefreshableSubscription[] {
	// The stored provider ids that represent a subscription login (+ a label).
	const subProviders = new Map<string, string>();
	for (const p of PROVIDERS) {
		if (!p.subscription) continue;
		const stored = (p as { providerId?: string }).providerId ?? p.id;
		if (!subProviders.has(stored)) subProviders.set(stored, p.name);
	}

	let profiles: Record<string, RefreshScanProfile & { provider?: string }> = {};
	try {
		const file = readProfiles(agentId) as unknown as {
			profiles?: Record<string, RefreshScanProfile & { provider?: string }>;
		};
		profiles = file.profiles ?? {};
	} catch {
		return [];
	}

	const out: UnrefreshableSubscription[] = [];
	const seen = new Set<string>();
	for (const prof of Object.values(profiles)) {
		const provider = prof?.provider;
		if (!provider || !subProviders.has(provider) || seen.has(provider)) continue;
		const reason = classifySubscriptionRefresh(prof);
		if (reason) {
			seen.add(provider);
			out.push({ provider, label: subProviders.get(provider)!, reason });
		}
	}
	return out;
}

/** One-line-per-provider operator warning, or "" when healthy. */
export function formatUnrefreshableWarning(list: readonly UnrefreshableSubscription[]): string {
	if (list.length === 0) return "";
	const lines = list.map((c) => `  • ${c.label}: ${c.reason}`);
	return [
		"Subscription login(s) that can't auto-refresh and will eventually fail:",
		...lines,
		"Fix: run `brigade login` to sign in again (stores a refreshable credential).",
	].join("\n");
}
