/**
 * Auth bridge — reads Brigade's `auth-profiles.json` (the file `brigade onboard`
 * actually writes) and produces a Pi `AuthStorage` that the lifted CLI surfaces
 * (`brigade chat`, `brigade gateway`) can hand to `ModelRegistry`.
 *
 * Without this, those commands would default to `AuthStorage.create(<dir>/auth.json)` —
 * Pi's vanilla on-disk store — and never see the keys onboarding wrote into
 * `~/.brigade/agents/main/agent/auth-profiles.json`. Mutually invisible.
 *
 * This is a deliberately small subset of `agents/agent-loop.ts`'s
 * `readAuthProfilesAsCredentialMap` + `buildAuthStorage` (cooldown filtering
 * skipped — only Primitive #1's run loop needs that). Duplicating the small
 * surface here keeps the agent-loop module untouched per the lift-scope rule.
 */
import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { PROVIDERS } from "../providers/catalog.js";
import { readProfiles } from "../auth/profiles.js";

// Minimal shape we read from auth-profiles.json. Mirrors `AuthProfile` in
// `src/auth/profiles.ts` but only the fields the credential-map build needs.
interface ReadProfile {
  provider?: string;
  type?: string;
  key?: string;
  // BrigadeSecretRef when set: {source, provider, id}. We only resolve
  // `source: "env"` here — file/exec backends require an async resolver and
  // are out of scope for the bridge's synchronous build.
  keyRef?: { source?: string; provider?: string; id?: string } | string;
  // oauth / token profiles (subscription login).
  access?: string;
  accessRef?: { source?: string; provider?: string; id?: string } | string;
  refresh?: string;
  refreshRef?: { source?: string; provider?: string; id?: string } | string;
  expires?: number;
  token?: string;
  tokenRef?: { source?: string; provider?: string; id?: string } | string;
  // Free-form provider metadata (scopes, account id, availableModelIds, …).
  // Must reach Pi for the oauth path — Copilot enterprise refresh +
  // availableModelIds ride here.
  metadata?: Record<string, unknown>;
}

interface ReadProfilesFile {
  profiles?: Record<string, ReadProfile>;
}

/**
 * Build a Pi `AuthStorage` populated from Brigade's auth-profiles.json. Returns
 * an empty storage when the file is missing or unparseable so callers can
 * decide whether to surface "no key" themselves (chat re-onboards; gateway
 * throws a clean config error).
 */
export function loadBrigadeAuthStorage(agentId: string = DEFAULT_AGENT_ID): unknown {
  const credentials = readBrigadeCredentials(agentId);
  const Storage = AuthStorage as unknown as {
    inMemory?: (data?: unknown) => unknown;
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof Storage.inMemory === "function") {
    return Storage.inMemory(credentials);
  }
  if (typeof Storage.fromStorage === "function") {
    return Storage.fromStorage({
      withLock<T>(update: (current: string) => { result: T; next?: string }): T {
        const { result } = update(JSON.stringify(credentials, null, 2));
        return result;
      },
    });
  }
  throw new Error(
    "Pi AuthStorage exposes neither inMemory nor fromStorage; pin to 0.70.x or update brigade.",
  );
}

function readBrigadeCredentials(agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Route through the mode-aware `readProfiles` choke point: filesystem mode
  // reads auth-profiles.json, convex mode reads the in-process cache primed
  // at boot from the sealed authProfiles table. Either way the bridge sees
  // the same profiles the agent kernel does.
  let parsed: ReadProfilesFile = {};
  try {
    parsed = readProfiles(agentId) as unknown as ReadProfilesFile;
  } catch {
    // Fall through to env-backed bootstrap.
  }
  for (const profile of Object.values(parsed.profiles ?? {})) {
    if (!profile?.provider) continue;
    if (out[profile.provider] !== undefined) continue; // first-wins per provider
    // Subscription credentials (OAuth login / setup-token) pass straight
    // through — Pi's AuthStorage handles {type:"oauth"} (auto-refresh) and
    // detects an `sk-ant-oat…` token to switch to Bearer auth.
    if (profile.type === "oauth" || profile.type === "token") {
      const cred = subscriptionProfileToCredential(profile);
      if (cred) out[profile.provider] = cred;
      continue;
    }
    if (profile.type !== "api_key") continue;
    const resolvedKey = resolveProfileKey(profile);
    if (resolvedKey) out[profile.provider] = { type: "api_key", key: resolvedKey };
  }
  // Env-backed bootstrap. If a user has ANTHROPIC_API_KEY (or the OAuth-token
  // fallback ANTHROPIC_OAUTH_TOKEN) exported but never ran `brigade onboard`,
  // surface it so Pi's registry exposes the provider. Profile-stored creds
  // take precedence — env is only consulted when a provider has no profile.
  for (const provider of PROVIDERS) {
    if (provider.noAuth) continue;
    if (out[provider.id] !== undefined) continue;
    const envNames = [provider.envVar, ...(provider.envVarFallbacks ?? [])];
    for (const name of envNames) {
      if (!name) continue;
      const value = process.env[name];
      if (!value) continue;
      out[provider.id] = { type: "api_key", key: value };
      break;
    }
  }
  return out;
}

// Resolve a literal-or-ref secret value (key / access / refresh / token).
// String refs are the legacy `${ENV_VAR}` form; object refs (BrigadeSecretRef)
// resolve only env source synchronously — file/exec backends are out of scope
// for the bridge's sync build.
function resolveRefValue(
  value: string | undefined,
  ref: { source?: string; provider?: string; id?: string } | string | undefined,
): string {
  if (value && value.length > 0) return value;
  if (!ref) return "";
  if (typeof ref === "string") {
    const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
    if (m && m[1]) return process.env[m[1]] ?? "";
    return ref;
  }
  if (ref.source === "env" && ref.id) return process.env[ref.id] ?? "";
  return "";
}

function resolveProfileKey(profile: ReadProfile): string {
  return resolveRefValue(profile.key, profile.keyRef);
}

// Map an OAuth-login / setup-token profile to a Pi credential. OAuth →
// {type:"oauth", access, refresh, expires} (Pi auto-refreshes); token →
// {type:"api_key", key} so Pi's value-based `sk-ant-oat` Bearer detection
// fires. Returns null when no secret resolves.
function subscriptionProfileToCredential(profile: ReadProfile): Record<string, unknown> | null {
  if (profile.type === "oauth") {
    const access = resolveRefValue(profile.access, profile.accessRef);
    if (!access) return null;
    const refresh = resolveRefValue(profile.refresh, profile.refreshRef);
    // A durable oauth profile CAN lack `expires` (the Claude/Codex CLI-login
    // path). Coerce a missing/garbage value to 0 so Pi treats the access token
    // as expired and refreshes via the refresh token immediately. Spread
    // `metadata` FIRST so the known oauth fields always win — it carries the
    // extras (Copilot enterprise refresh + availableModelIds) Pi needs.
    const expires =
      typeof profile.expires === "number" && Number.isFinite(profile.expires)
        ? profile.expires
        : 0;
    return {
      ...(profile.metadata && typeof profile.metadata === "object" ? profile.metadata : {}),
      type: "oauth",
      access,
      refresh: refresh || undefined,
      expires,
    };
  }
  if (profile.type === "token") {
    const token = resolveRefValue(profile.token, profile.tokenRef);
    if (!token) return null;
    return { type: "api_key", key: token };
  }
  return null;
}
