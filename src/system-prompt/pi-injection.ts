import type { AgentSession } from "@mariozechner/pi-coding-agent";

// Pin an assembled persona string into Pi's session as the system prompt.
//
// Three writes are needed because Pi rebuilds the system prompt internally
// whenever the active tool list changes (e.g. when a turn enables/disables
// tools). Setting only `state.systemPrompt` works for turn 1, then Pi's
// `_rebuildSystemPrompt()` overwrites it with its stock prompt on turn 2.
// The fix:
//
//   1. state.systemPrompt — what Pi reads at request time.
//   2. _baseSystemPrompt — Pi's internal "what was the last *base* prompt?"
//      cache. Without overwriting this, Pi sees state.systemPrompt has
//      changed and triggers a rebuild → stock prompt.
//   3. _rebuildSystemPrompt — Pi's tool-list-change rebuild hook. Replacing
//      it with `() => prompt` pins the persona across tool changes.
//
// All three writes happen synchronously before any turn starts. Re-call
// after model switches and post-compaction so a freshly cloned session
// inherits the persona.

export type PersonaOverride = string | ((defaultPrompt?: string) => string);

export function applyPersonaOverrideToSession(
  session: AgentSession,
  override: PersonaOverride,
): void {
  const prompt =
    typeof override === "function" ? override().trim() : override.trim();
  if (!prompt) return;

  session.agent.state.systemPrompt = prompt;

  const internal = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  internal._baseSystemPrompt = prompt;
  internal._rebuildSystemPrompt = () => prompt;
}

// Convenience builder: closes over an assembled prompt so callers can pass
// the captured value through plumbing that expects a `() => string`.
export function createPersonaOverride(prompt: string): PersonaOverride {
  return () => prompt;
}
