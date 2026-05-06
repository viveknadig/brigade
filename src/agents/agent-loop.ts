// Brigade's wrapper around the Pi SDK agent loop. Single-turn driver:
//   1. Resolve session (key → id → JSONL transcript path).
//   2. Build a Pi AuthStorage from the on-disk auth-profiles store (api_key
//      profiles only; oauth/token shapes are queued for the next layer).
//   3. Construct a ModelRegistry over auth + models.json. Pi merges in its
//      built-in catalog so an empty models.json still resolves known
//      Anthropic / OpenAI / Google / Ollama models.
//   4. Open a SessionManager at <agentDir>/sessions/<sessionId>.jsonl —
//      Pi creates the file lazily on first append.
//   5. createAgentSession with the resolved model + persona-aware
//      DefaultResourceLoader.
//   6. Assemble the persona prompt and pin it via the three-write hack
//      (state.systemPrompt + _baseSystemPrompt + _rebuildSystemPrompt) so
//      Pi's tool-list rebuild can't clobber the persona on turn 2+.
//   7. session.prompt(userMessage). Defensive settle wait with a 30s
//      budget guards against runaway compactions.
//   8. Return the last assistant message text + raw message array.
//
// Pi 0.50+ removed the `discover*` convenience helpers, so brigade builds
// AuthStorage directly via the class's `inMemory` factory and ModelRegistry
// via its `create` static (with a `new` fallback for older minors).

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";

import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAuthProfilesPath,
  resolveModelsPath,
} from "../config/paths.js";
import {
  defaultSessionKey,
  resolveOrCreateSession,
} from "../sessions/session-store.js";
import { readConfigOrInit } from "../config/io.js";
import { assembleSystemPrompt } from "../system-prompt/assembler.js";
import {
  loadHeartbeatFile,
  loadWorkspaceContextFiles,
} from "../system-prompt/workspace-loader.js";
import { resolveSystemPromptOverride } from "../system-prompt/override.js";
import { resolveRuntimeParams } from "../system-prompt/runtime-params.js";
import { applyPersonaOverrideToSession } from "../system-prompt/pi-injection.js";
import {
  evaluateBootstrapPhase,
  markSetupCompleted,
  type BootstrapPhase,
} from "../workspace/state.js";
import {
  hasDeliveredBootstrapToSession,
  markBootstrapDeliveredToSession,
} from "../sessions/bootstrap-marker.js";
import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { runWithRetry } from "./retry-policy.js";
import { scrubAnthropicRefusalSentinel } from "./error-classifier.js";
import { buildBrigadeTransformContext } from "./payload-mutators.js";
import { repairSessionFileIfNeeded } from "../sessions/session-file-repair.js";
import {
  clearExpiredCooldowns,
  loadProfileState,
  markProfileFailure,
  markProfileSuccess,
} from "../auth/profile-cooldown.js";
import { orderProfilesForSelection } from "../auth/profile-cooldown.js";
import {
  wrapStreamFnWithIdleTimeout,
  wrapStreamFnWithStopReasonRecovery,
  wrapStreamFnWithToolCallRepair,
} from "./stream-wrappers.js";

const log = createSubsystemLogger("loop/turn");

// Default idle-timeout for a streaming provider response. Bypassed by setting
// `BRIGADE_LLM_IDLE_TIMEOUT_SECONDS=0`. Tuned to 90s — comfortably above the
// slowest Anthropic Opus reasoning warmup, well below the limit at which a
// hung connection wastes a session's worth of tokens of headroom.
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 90_000;

function resolveIdleTimeoutMs(): number {
  const raw = process.env.BRIGADE_LLM_IDLE_TIMEOUT_SECONDS?.trim();
  if (!raw) return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LLM_IDLE_TIMEOUT_MS;
  return Math.floor(n * 1000);
}

export interface RunSingleTurnArgs {
  agentId: string;
  provider: string;
  modelId: string;
  message: string;
  sessionKey?: string;
  // Override the agent's workspace dir (where persona/SOUL/USER files live).
  // Defaults to <agentDir>/workspace via paths.ts.
  workspaceDir?: string;
  // The cwd Pi tools (read/bash/write/etc.) operate in. Defaults to the
  // current process cwd so `brigade agent -m "…"` from any directory does
  // what the user expects. Distinct from workspaceDir, which scopes
  // *persona files* — those live with the agent, not with the project.
  cwd?: string;
  // Pi accepts "off" | "low" | "medium" | "high". Some providers (e.g. Gemini
  // 2.5 Pro) reject "off" — derive from model.reasoning when wiring tools.
  thinkingLevel?: "off" | "low" | "medium" | "high";
  // Caller-provided cancellation. Wired into the retry loop so a Ctrl-C from
  // the CLI / a WS disconnect from the gateway aborts cleanly. Pi 0.70.x's
  // session.prompt does not accept a signal, so the abort takes effect at
  // the *next* retry boundary; callers wanting hard mid-stream cancellation
  // should call session.abort() directly in the signal listener.
  signal?: AbortSignal;
}

export interface RunSingleTurnResult {
  sessionId: string;
  sessionKey: string;
  isNewSession: boolean;
  reply: string;
  messages: unknown[];
}

export async function runSingleTurn(args: RunSingleTurnArgs): Promise<RunSingleTurnResult> {
  const agentId = args.agentId;
  const sessionKey = args.sessionKey ?? defaultSessionKey(agentId);
  const agentDir = resolveAgentDir(agentId);
  const workspaceDir = resolveAgentWorkspaceDir(agentId, args.workspaceDir);
  const cwd = args.cwd ?? process.cwd();
  const modelsFile = resolveModelsPath(agentId);
  const authProfilesPath = resolveAuthProfilesPath(agentId);

  const resolved = resolveOrCreateSession({
    agentId,
    sessionKey,
    overrides: { provider: args.provider, modelId: args.modelId },
  });

  // Profile cooldown gate. The on-disk profile-state.json tracks per-profile
  // failure history, cooldown windows, and disabled-until timestamps. We
  // sweep expired windows up-front so a profile that was rate-limited an
  // hour ago is eligible again now, then pass the eligibility filter to
  // the credential-map builder so cooled profiles don't get handed to Pi.
  let cooldownState = loadProfileState(agentId);
  cooldownState = clearExpiredCooldowns(cooldownState);
  const authBuild = buildAuthStorage(authProfilesPath, {
    cooldownState,
    provider: args.provider,
    modelId: args.modelId,
  });
  const authStorage = authBuild.storage;
  const selectedProfileId = authBuild.selectedProfileId;
  const modelRegistry = buildModelRegistry(authStorage, modelsFile);

  // ModelRegistry.find returns undefined when the provider+modelId pair isn't
  // registered. Surface a clear error so the user knows to seed models.json
  // (or wire `brigade auth login` once that command lands).
  //
  // Pi version drift guard: if a future Pi minor renames or removes `find`,
  // throw a curated error rather than letting a raw `TypeError: undefined
  // is not a function` surface from inside Pi.
  const registryAsFinder = modelRegistry as { find?: (p: string, m: string) => unknown };
  if (typeof registryAsFinder.find !== "function") {
    throw new Error(
      "Pi ModelRegistry.find is not a function — likely a Pi SDK version drift. " +
        "Brigade was built against the 0.70.x ModelRegistry surface. " +
        "Pin `@mariozechner/pi-coding-agent` to a known-compatible version, or " +
        "update brigade's agent-loop to match the new Pi API.",
    );
  }
  const model = registryAsFinder.find(args.provider, args.modelId);
  if (!model) {
    throw new Error(
      `Model not registered: provider=${args.provider} model=${args.modelId}.\n` +
        `  • Pi's built-in catalog covers known Anthropic/OpenAI/Google/Ollama models;\n` +
        `    if yours isn't listed, append an entry to ${modelsFile}\n` +
        `    (one object under .providers.<provider>.models[]).\n` +
        `  • For local Ollama: run \`ollama pull <model>\` first.\n` +
        `  • Verify your auth profile is configured: ` +
        `\`cat ${resolveAuthProfilesPath(args.agentId)}\``,
    );
  }

  // Repair any malformed JSONL lines in the transcript before Pi opens it.
  // A power-loss / SIGKILL during a previous append can leave a partial
  // last line that throws on JSON.parse — without this pass the next run
  // would crash on session open with no obvious cause. The repair is
  // idempotent + atomic (writes a `.bak-<pid>-<ts>` snapshot first), so a
  // failed repair leaves the original file intact.
  const repairReport = await repairSessionFileIfNeeded({
    sessionFile: resolved.transcriptPath,
  });
  if (repairReport.repaired) {
    log.warn("session file repaired before open", {
      sessionId: resolved.sessionId,
      droppedLines: repairReport.droppedLines,
      backupPath: repairReport.backupPath,
    });
  }

  // SessionManager.open creates the JSONL on first write; passing the
  // canonical transcript path keeps Pi and brigade aligned on filenames.
  const sessionManager = SessionManager.open(resolved.transcriptPath);

  // Anthropic models are the only family today that enforce a hard
  // cache_control breakpoint cap (Anthropic accepts ≤4). Run the sweep
  // unconditionally — it's a safe no-op for non-Anthropic providers because
  // their messages don't carry cache_control blocks. The scrubber pass
  // (refusal sentinel) always runs.
  const transformContext = buildBrigadeTransformContext({
    applyAnthropicSweep: args.provider === "anthropic" || args.provider.startsWith("anthropic"),
  });

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model as never,
    thinkingLevel: args.thinkingLevel ?? "off",
    tools: [],
    customTools: [],
    sessionManager,
    resourceLoader: new DefaultResourceLoader({ cwd, agentDir }),
    transformContext,
  } as never);

  if (!session) {
    throw new Error("Pi createAgentSession returned no session.");
  }

  // Compose stream-fn wrappers around Pi's auth-aware streamFn. Order
  // matters and is from-the-outside-in: the outermost wrapper sees events
  // last (closest to Pi's consumer), the innermost sees them first
  // (closest to the provider). We chain idle-timeout outermost so a hung
  // provider trips the timer regardless of inner repair work; tool-call
  // repair is innermost so even a malformed delta from the wire gets
  // cleaned before the stop-reason wrapper sees it.
  //
  // Crucially — never REPLACE Pi's streamFn (a brigade memory note locks
  // this in: replacement loses the auth wrapping and every call goes
  // silently keyless). Wrapping preserves Pi's wrapper at the bottom of
  // the call stack.
  const sessionAgent = (session as AgentSession & {
    agent?: { streamFn?: import("./stream-wrappers.js").BrigadeStreamFn };
  }).agent;
  if (sessionAgent && typeof sessionAgent.streamFn === "function") {
    const baseStreamFn = sessionAgent.streamFn;
    const idleTimeoutMs = resolveIdleTimeoutMs();
    sessionAgent.streamFn = wrapStreamFnWithIdleTimeout(
      wrapStreamFnWithStopReasonRecovery(
        wrapStreamFnWithToolCallRepair(baseStreamFn),
      ),
      { timeoutMs: idleTimeoutMs },
    );
    log.debug("stream wrappers installed", {
      idleTimeoutMs,
      provider: args.provider,
      model: args.modelId,
    });
  }

  // Detect lifecycle phase BEFORE the turn. Two layers stack here:
  //   1. Workspace-level phase from workspace-state.json. Scopes to
  //      "has this workspace been onboarded? has BOOTSTRAP.md been
  //      consumed?" Persists across sessions.
  //   2. Per-session bootstrap-delivery marker in the JSONL transcript.
  //      Scopes to "has the full bootstrap context already been
  //      delivered to *this* session, and not invalidated by a
  //      compaction since?" Lets sub-agent forks and post-compaction
  //      recovery emit the first-turn nudge again when needed, while
  //      the workspace has long since completed setup.
  const phaseBefore = await evaluateBootstrapPhase(workspaceDir);
  const sessionAlreadyHasBootstrap = await hasDeliveredBootstrapToSession(
    resolved.transcriptPath,
  );
  // The assembler should only emit the synthetic first-turn nudge when
  // BOTH conditions hold: workspace says first-turn AND this session
  // hasn't received the bootstrap context yet. This is what stops the
  // nudge from re-firing on every continuing-session turn just because
  // BOOTSTRAP.md still happens to be on disk.
  const effectivePhase: BootstrapPhase =
    phaseBefore === "first-turn" && sessionAlreadyHasBootstrap
      ? "in-progress"
      : phaseBefore;

  // Pin the assembled persona before the first turn. Done after
  // createAgentSession (which has already set up Pi's stock prompt) but
  // before prompt() so the model sees the brigade-flavoured persona on
  // turn 1 and on every subsequent turn (the pi-injection helper patches
  // the rebuild hook so tool-list changes don't clobber it).
  const personaPrompt = await buildPersonaPrompt({
    agentId,
    workspaceDir,
    cwd,
    modelLabel: `${args.provider}/${args.modelId}`,
    thinkingLevel: args.thinkingLevel ?? "off",
    bootstrapPhase: effectivePhase,
  });
  if (personaPrompt) {
    applyPersonaOverrideToSession(session as AgentSession, personaPrompt);
  }

  // prompt() runs a full user turn — Pi enqueues the message, drives the
  // agent loop, and resolves once the turn is complete (assistant reply
  // committed to messages, isStreaming/isCompacting cleared).
  //
  // Do NOT use steer() here: steer is for *mid-turn* injection. With no
  // active run it just enqueues into the steering buffer and returns
  // immediately — the assistant never speaks and brigade prints nothing.
  //
  // Wrapped in runWithRetry so a transient provider failure (rate limit,
  // overload, timeout) is automatically retried with backoff + jitter
  // instead of surfacing as a hard turn error to the caller. Same-model
  // retries only — multi-model fallback is one layer up (see
  // model-fallback.ts), which is wired in by the resilient agent runner.
  //
  // The user message is scrubbed of the Anthropic refusal-trigger magic
  // string before Pi sees it; otherwise a paste-through of that literal
  // would coerce Claude into refusing the next turn.
  const scrubbedMessage = scrubAnthropicRefusalSentinel(args.message);
  log.info("turn starting", {
    agentId,
    sessionId: resolved.sessionId,
    isNewSession: resolved.isNew,
    provider: args.provider,
    model: args.modelId,
    bootstrapPhase: effectivePhase,
  });

  await runWithRetry({
    ctx: { provider: args.provider, model: args.modelId },
    signal: args.signal,
    onAttemptFailed: (info) => {
      const fields = {
        agentId,
        sessionId: resolved.sessionId,
        provider: args.provider,
        model: args.modelId,
        attempt: info.attemptIndex,
        reason: info.reason,
        willRetry: info.willRetry,
        backoffMs: info.backoffMs,
        error: info.errorSummary,
        profileId: selectedProfileId,
      };
      if (info.willRetry) log.warn("turn attempt failed, retrying", fields);
      else log.error("turn attempt failed, surfacing", fields);
      // Update the on-disk cooldown state so this profile rotates out on
      // the next run if its failure category warrants a cooldown. Skipped
      // when no profile id was tracked (single-profile fallback path).
      if (selectedProfileId) {
        cooldownState = markProfileFailure({
          agentId,
          state: cooldownState,
          profileId: selectedProfileId,
          reason: info.reason,
          modelId: args.modelId,
        });
      }
    },
    attempt: async (_attemptIndex, _signal) => {
      await (session as AgentSession).prompt(scrubbedMessage);
      // Defensive settle wait. prompt() should already have settled the
      // run, but if Pi adds queued steers or background compactions in a
      // future minor, this catches the late activity.
      await waitForStreamSettled(session as AgentSession);
    },
  });

  // Successful turn — clear any prior failure state on the profile so the
  // next run prefers it again under the round-robin order.
  if (selectedProfileId) {
    cooldownState = markProfileSuccess({
      agentId,
      state: cooldownState,
      profileId: selectedProfileId,
      provider: args.provider,
    });
  }

  log.info("turn settled", {
    agentId,
    sessionId: resolved.sessionId,
    provider: args.provider,
    model: args.modelId,
  });

  const reply = extractLastAssistantText(session as AgentSession);

  // After-turn lifecycle:
  //
  // 1. If we just delivered the full bootstrap context to this session
  //    (workspace was first-turn AND session hadn't received it before),
  //    emit the per-session marker into the JSONL transcript. Subsequent
  //    turns short-circuit the nudge because the model already has the
  //    context cached.
  if (phaseBefore === "first-turn" && !sessionAlreadyHasBootstrap) {
    markBootstrapDeliveredToSession(sessionManager);
  }

  // 2. Stamp setupCompletedAt the first time we observe BOOTSTRAP.md is
  //    gone after seeding. The check fires on EVERY turn (not just on a
  //    within-turn first-turn → complete transition) because BOOTSTRAP.md
  //    can be deleted out of band — by the user from another shell, or
  //    by the previous turn's reply. markSetupCompleted is idempotent.
  const phaseAfter = await evaluateBootstrapPhase(workspaceDir);
  if (phaseAfter === "complete") {
    await markSetupCompleted(workspaceDir);
  }

  return {
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
    isNewSession: resolved.isNew,
    reply,
    messages: (session as AgentSession).messages.slice(),
  };
}

// Build the per-turn system prompt. Three steps:
//   1. Honour an explicit override in brigade.json (escape hatch — replaces
//      the assembled prompt entirely).
//   2. Otherwise load workspace persona files + heartbeat + runtime, run
//      them through the assembler.
//   3. Empty workspace → return empty so Pi keeps its stock prompt rather
//      than getting an empty system message it might balk at.
async function buildPersonaPrompt(args: {
  agentId: string;
  workspaceDir: string;
  cwd: string;
  modelLabel: string;
  thinkingLevel: string;
  bootstrapPhase: BootstrapPhase;
}): Promise<string> {
  const config = readConfigOrInit();
  const override = resolveSystemPromptOverride({ config, agentId: args.agentId });
  if (override) return override;

  const personaFiles = await loadWorkspaceContextFiles(args.workspaceDir);
  const heartbeatFile = await loadHeartbeatFile(args.workspaceDir);
  if (personaFiles.length === 0 && !heartbeatFile) return "";

  const runtime = resolveRuntimeParams({
    agentId: args.agentId,
    workspaceDir: args.workspaceDir,
    cwd: args.cwd,
    modelLabel: args.modelLabel,
    thinkingLevel: args.thinkingLevel,
  });

  const assembled = assembleSystemPrompt({
    runtime,
    personaFiles,
    heartbeatFile,
    toolDescriptions: [],
    bootstrapPhase: args.bootstrapPhase,
  });
  return assembled.text;
}

// AuthStorage in Pi 0.70.x exposes multiple factories across versions
// (inMemory, fromStorage). We prefer inMemory with the parsed profile blob
// because brigade's auth-profiles.json is small enough to load eagerly.
//
// `cooldownFilter` (optional) is the profile-cooldown gate: profiles that
// are currently cooled or disabled are skipped during credential-map build,
// and within an eligible bucket the most-recently-successful profiles are
// preferred. Falls back to the original "first matching wins" behaviour
// when the filter is omitted (back-compat for tests + bootstrap callsites).
interface AuthStorageCooldownFilter {
  cooldownState: import("../auth/profile-cooldown.js").ProfileStateFile;
  provider: string;
  modelId?: string;
}

interface AuthStorageBuildResult {
  storage: unknown;
  // The profileId that was selected for the active provider, if any. Used
  // by the run lifecycle to update cooldown state on success/failure.
  selectedProfileId?: string;
}

function buildAuthStorage(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
): AuthStorageBuildResult {
  const { credentials, selectedProfileId } = readAuthProfilesAsCredentialMap(
    authProfilesPath,
    cooldownFilter,
  );
  const Storage = AuthStorage as unknown as {
    inMemory?: (data?: unknown) => unknown;
    fromStorage?: (storage: unknown) => unknown;
  };
  let storage: unknown;
  if (typeof Storage.inMemory === "function") {
    storage = Storage.inMemory(credentials);
  } else if (typeof Storage.fromStorage === "function") {
    // Fallback path for Pi minors that removed inMemory.
    storage = Storage.fromStorage({
      withLock<T>(
        update: (current: string) => { result: T; next?: string },
      ): T {
        const { result } = update(JSON.stringify(credentials, null, 2));
        return result;
      },
    });
  } else {
    throw new Error(
      "Pi AuthStorage exposes neither inMemory nor fromStorage; pin to 0.70.x or update brigade.",
    );
  }
  return { storage, selectedProfileId };
}

// Brigade's auth-profiles.json shape matches the Pi SDK contract: profiles
// are keyed by `<provider>:<alias>` and discriminated on `type`. Pi's
// in-memory storage expects the credential map keyed by provider id with
// `{type: "api_key", key}`.
//
// When a `cooldownFilter` is supplied we apply two extra passes:
//
//   1. Eligibility — drop profiles whose entry in profile-state.json is in
//      cooldown / disabled for the active provider+model. If every profile
//      for a provider is cooled, fall back to the soonest-expiry one as a
//      probe (so the run still has a chance to recover instead of hard-
//      failing on "no eligible auth").
//
//   2. Ordering — within the eligible bucket, prefer profiles by
//      `lastUsed`-asc round-robin so we don't keep hitting the same key
//      turn after turn. The first eligible profile per provider wins.
interface ReadCredentialsResult {
  credentials: Record<string, unknown>;
  // Profile id selected for the active provider (if cooldownFilter was
  // supplied). Used downstream to mark cooldown success/failure on the
  // exact profile that ran.
  selectedProfileId?: string;
}

function readAuthProfilesAsCredentialMap(
  authProfilesPath: string,
  cooldownFilter?: AuthStorageCooldownFilter,
): ReadCredentialsResult {
  if (!fs.existsSync(authProfilesPath)) return { credentials: {} };
  let parsed: {
    profiles?: Record<
      string,
      { provider?: string; type?: string; key?: string; keyRef?: string; alias?: string }
    >;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(authProfilesPath, "utf8"));
  } catch {
    return { credentials: {} };
  }
  const out: Record<string, unknown> = {};
  let selectedProfileId: string | undefined;
  // Bucket profiles by provider so we can apply the cooldown ordering before
  // collapsing to "first wins" per provider.
  const byProvider = new Map<
    string,
    { profileId: string; provider: string; resolvedKey: string }[]
  >();
  for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
    if (!profile?.provider || profile.type !== "api_key") continue;
    const literal = profile.key ?? profile.keyRef ?? "";
    const resolvedKey = expandEnvRef(literal, profile.provider);
    if (!resolvedKey) continue;
    const list = byProvider.get(profile.provider) ?? [];
    list.push({ profileId, provider: profile.provider, resolvedKey });
    byProvider.set(profile.provider, list);
  }

  for (const [provider, list] of byProvider) {
    if (cooldownFilter && provider === cooldownFilter.provider) {
      const ordered = orderProfilesForSelection({
        state: cooldownFilter.cooldownState,
        provider,
        profileIds: list.map((p) => p.profileId),
        forModel: cooldownFilter.modelId,
      });
      // Pick the first eligible profile (orderProfilesForSelection puts
      // eligibles first, then cooled by soonest-expiry as probes).
      let selected = list.find((p) => p.profileId === ordered[0]);
      // If the cooldown filter excluded everyone, fall back to the first
      // available so the run gets at least one attempt.
      if (!selected) selected = list[0];
      if (selected) {
        out[provider] = { type: "api_key", key: selected.resolvedKey };
        selectedProfileId = selected.profileId;
      }
    } else {
      const first = list[0];
      if (first) out[provider] = { type: "api_key", key: first.resolvedKey };
    }
  }
  return { credentials: out, selectedProfileId };
}

const ENV_REF_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

// Resolve a literal-or-${VAR} secret. If the value is a `${VAR}` reference
// and the env var isn't set, log a warning to stderr so the user gets a
// breadcrumb pointing at the missing env var instead of a downstream
// "no API key found" from Pi with no context about *why*.
function expandEnvRef(value: string, provider: string): string {
  const m = ENV_REF_PATTERN.exec(value);
  if (!m || !m[1]) return value;
  const resolved = process.env[m[1]] ?? "";
  if (!resolved) {
    console.error(
      `brigade: auth profile for ${provider} references ${value} ` +
        `but the env var isn't set; the profile will be skipped.`,
    );
  }
  return resolved;
}

function buildModelRegistry(authStorage: unknown, modelsFile: string): unknown {
  const Registry = ModelRegistry as unknown as {
    create?: (authStorage: unknown, modelsFile: string) => unknown;
    new (authStorage: unknown, modelsFile: string): unknown;
  };
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsFile);
  }
  return new Registry(authStorage, modelsFile);
}

// Both flags must clear for the turn to be considered done. prompt() is
// supposed to resolve only after settle, so this loop almost always exits
// on the first iteration. The 30s budget guards against the pathological
// case where Pi enters an unbounded compaction or a streaming hang we'd
// otherwise wait on forever.
const STREAM_SETTLE_BUDGET_MS = 30_000;
const STREAM_SETTLE_POLL_MS = 50;

async function waitForStreamSettled(session: AgentSession): Promise<void> {
  const deadline = Date.now() + STREAM_SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!session.isStreaming && !session.isCompacting) return;
    await sleep(STREAM_SETTLE_POLL_MS);
  }
  throw new Error(
    `Turn did not settle within ${STREAM_SETTLE_BUDGET_MS / 1000}s ` +
      `(isStreaming=${session.isStreaming} isCompacting=${session.isCompacting}). ` +
      `Likely a hung provider connection — abort the run and retry.`,
  );
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    return flattenAssistantContent(m.content);
  }
  return "";
}

function flattenAssistantContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
