// Provider quirks and payload mutators.
//
// Per-provider tweaks that have to happen between Pi's message-array and the
// HTTPS body the provider expects. Pi 0.70.x exposes two relevant hook
// surfaces we can use without monkey-patching its internal streamFn:
//
//   • `transformContext(messages, signal)` — runs at the AgentMessage layer
//     before `convertToLlm`. Right place for message-level cleanup like
//     stale cache_control sweeps.
//   • `streamFn` — Pi installs an auth-aware wrapper at session creation
//     time; do NOT replace it (a Brigade-side memory captures the failure
//     mode — every provider call breaks silently). For payload-shape
//     mutations we'd need to wrap the wrapper, deferred until Pi exposes
//     a `wrapStreamFn` factory or until the gateway moves provider calls
//     out-of-process.
//
// What ships here today: the safe mutations that fit `transformContext`'s
// contract (must not throw, must return the original or a safe fallback).
// Provider-payload mutations that need access to the outbound HTTP body
// are documented but parked behind a feature flag until the wiring exists.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { scrubAnthropicRefusalSentinel } from "./error-classifier.js";

// ─────────────────────────────────────────────────────────────────────────────
// History-image prune.
//
// Long sessions with screenshots or uploaded images blow up the context
// window even after the model has "seen" them. After 3 completed user→
// assistant turns, the older images can be replaced with a placeholder
// without losing meaningful context — the model already incorporated them
// into the running summary it builds on each turn.
// ─────────────────────────────────────────────────────────────────────────────

const PRESERVE_RECENT_COMPLETED_TURNS = 3;
const PRUNED_HISTORY_IMAGE_MARKER =
  "[image data removed — already processed by model in earlier turn]";

export function pruneProcessedHistoryImages<M extends AgentMessage>(messages: M[]): M[] {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex <= 0) return messages;

  let mutated = false;
  const out = messages.map((m, i) => {
    if (i >= pruneBeforeIndex) return m;
    if (!m) return m;
    const role = (m as { role?: string }).role;
    if (role !== "user" && role !== "toolResult") return m;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    let blockMutated = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: string };
      if (b.type !== "image") return block;
      blockMutated = true;
      return { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER };
    });
    if (blockMutated) {
      mutated = true;
      return { ...(m as object), content: nextContent } as M;
    }
    return m;
  });
  return mutated ? out : messages;
}

function resolvePruneBeforeIndex<M extends AgentMessage>(messages: M[]): number {
  // Walk backwards counting user→assistant pairs. Once we've seen
  // PRESERVE_RECENT_COMPLETED_TURNS such pairs, return the index — every
  // message before that index is eligible for image pruning.
  let pairs = 0;
  let lastSeenRole: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = (m as { role?: string }).role;
    if (role === "assistant" && lastSeenRole !== "assistant") {
      lastSeenRole = "assistant";
    } else if (role === "user" && lastSeenRole === "assistant") {
      pairs++;
      lastSeenRole = "user";
      if (pairs >= PRESERVE_RECENT_COMPLETED_TURNS) {
        return i;
      }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic prompt cache hygiene.
//
// Anthropic enforces at most 4 cache_control breakpoints per request. If the
// transcript carries cache_control on every assistant message (because each
// turn appended one), the next turn fails with a 400 "too many cache
// breakpoints" error.
//
// The sweep walks the message array and clears cache_control from every
// content block EXCEPT the latest two: the assembled system prompt's stable
// prefix and the most-recent message tail. The system prompt's cache_control
// is set by the assembler, not us, so we leave the system message untouched
// and only sweep user/assistant turns.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CACHE_CONTROLS_KEPT_IN_TURNS = 1;

interface ContentBlockWithCacheControl {
  cache_control?: unknown;
  type?: string;
  [key: string]: unknown;
}

export function sweepStaleAnthropicCacheControl<M extends AgentMessage>(messages: M[]): M[] {
  // Walk from newest → oldest. Keep cache_control on the first
  // MAX_CACHE_CONTROLS_KEPT_IN_TURNS messages encountered (i.e. the most
  // recent ones); strip it from the rest.
  let kept = 0;
  const out: M[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as M;
    if (!m) continue;
    const role = (m as { role?: string }).role;
    // Don't touch the system prompt — the assembler owns its cache markers.
    if (role === "system") {
      out[i] = m;
      continue;
    }
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      out[i] = m;
      continue;
    }
    let mutated = false;
    let nextContent = content;
    if (kept < MAX_CACHE_CONTROLS_KEPT_IN_TURNS) {
      const hasCacheControl = content.some(
        (b) => b && typeof b === "object" && "cache_control" in (b as object),
      );
      if (hasCacheControl) kept++;
      out[i] = m;
      continue;
    }
    // Past the kept window — strip cache_control from every block.
    nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as ContentBlockWithCacheControl;
      if (!("cache_control" in b)) return block;
      const { cache_control: _drop, ...rest } = b;
      mutated = true;
      return rest;
    });
    out[i] = mutated ? ({ ...(m as object), content: nextContent } as M) : m;
  }
  // If the loop ran nothing was assigned for some indices (rare): backfill.
  for (let i = 0; i < messages.length; i++) {
    if (out[i] === undefined) {
      const m = messages[i];
      if (m !== undefined) out[i] = m;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic refusal-sentinel scrub on user content.
//
// The refusal magic literal is also stripped at the prompt-build site for
// fresh inputs (see agent-loop.ts). This pass catches the same literal in
// session replays where the prior transcript carried it across — Pi
// re-sends the full message history, so a poisoned earlier turn would
// otherwise re-trigger refusal indefinitely.
// ─────────────────────────────────────────────────────────────────────────────

export function scrubRefusalSentinelInTranscript<M extends AgentMessage>(messages: M[]): M[] {
  let mutated = false;
  const out = messages.map((m) => {
    if (!m) return m;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      const next = scrubAnthropicRefusalSentinel(content);
      if (next !== content) {
        mutated = true;
        return { ...(m as object), content: next } as M;
      }
      return m;
    }
    if (!Array.isArray(content)) return m;
    let blockMutated = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        const next = scrubAnthropicRefusalSentinel(b.text);
        if (next !== b.text) {
          blockMutated = true;
          return { ...b, text: next };
        }
      }
      return block;
    });
    if (blockMutated) {
      mutated = true;
      return { ...(m as object), content: nextContent } as M;
    }
    return m;
  });
  return mutated ? out : messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// composed transformContext for Pi.
//
// Plug into AgentSession's `transformContext`. The contract is "must not
// throw" — wrap each step in try/catch and fall back to the prior messages
// on any unexpected failure rather than letting the turn explode.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrigadeTransformContextOptions {
  // True when the active model is on Anthropic; controls whether the
  // cache_control sweep runs. Defaults to true because the sweep is a
  // safe no-op on transcripts without cache_control.
  applyAnthropicSweep?: boolean;
  // Strip image blocks from messages older than 3 completed turns. Defaults
  // to true — the prune is a safe no-op on text-only transcripts and saves
  // tens of thousands of tokens on image-heavy sessions.
  pruneOldImages?: boolean;
}

export function buildBrigadeTransformContext(
  options: BrigadeTransformContextOptions = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const applyAnthropicSweep = options.applyAnthropicSweep ?? true;
  const pruneOldImages = options.pruneOldImages ?? true;
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    let working = messages;
    try {
      working = scrubRefusalSentinelInTranscript(working);
    } catch {
      // safe fallback per Pi contract
    }
    if (pruneOldImages) {
      try {
        working = pruneProcessedHistoryImages(working);
      } catch {
        // safe fallback
      }
    }
    if (applyAnthropicSweep) {
      try {
        working = sweepStaleAnthropicCacheControl(working);
      } catch {
        // safe fallback per Pi contract
      }
    }
    return working;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-shape mutations that need outbound-HTTP access.
//
// These are documented as the next layer of the quirks pack. They do NOT
// run today because Pi 0.70.x doesn't expose a public `wrapStreamFn` and
// overwriting `session.agent.streamFn` would break Pi's auth-aware wrapper.
// When the wiring lands (either via a Pi PR or a Brigade-side gateway
// proxy), the implementations below plug in unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_QUIRKS_PARKED = {
  // OpenRouter: synthesise cache_control headers from message metadata so
  // the upstream provider sees a consistent prompt-cache contract.
  openrouterCacheHeaders: "park: needs streamFn wrap",
  // Google Gemini 2.5+: extract `thinking` blocks into a separate channel
  // because Gemini emits them at the SSE-payload level, not as content.
  geminiThinkingExtract: "park: needs streamFn wrap",
  // SiliconFlow: remap `reasoning_content` deltas onto `content` so the
  // assistant's reasoning shows up in the visible reply.
  siliconflowReasoningRemap: "park: needs streamFn wrap",
  // Minimax: switch to the fast-mode model when reasoning is off.
  minimaxFastModeSwitch: "park: needs streamFn wrap",
} as const;
