// Cache-boundary marker for the assembled system prompt.
//
// The assembler emits this marker between the *stable prefix* (persona
// files, runtime guidance, tool descriptions) and the *dynamic suffix*
// (heartbeat content, sub-agent context, time-of-turn additions). Anthropic
// prompt-caching honours the boundary so the stable prefix stays cached
// across turns even when the suffix changes.

// The marker as it appears on its own line inside the assembled prompt
// (the assembler pushes this as a discrete entry into a `lines` array, then
// joins with "\n", so the in-prompt form has surrounding newlines from the
// join — never include them in the constant itself).
export const CACHE_BOUNDARY_MARKER_LINE = "<!-- BRIGADE_CACHE_BOUNDARY -->";

// Pre-built newline-padded form for callers that want to insert/strip the
// marker via raw string ops on text not produced by the assembler.
export const CACHE_BOUNDARY_MARKER = `\n${CACHE_BOUNDARY_MARKER_LINE}\n`;

export interface SplitPrompt {
  stablePrefix: string;
  dynamicSuffix: string;
}

// Split an assembled prompt into its stable prefix and dynamic suffix.
// Returns dynamicSuffix === "" when the marker is absent — callers can
// treat the whole prompt as cacheable. Searches for the line form so a
// prompt produced by `lines.join("\n")` (which never has the wrapping
// newlines doubled) is matched correctly.
export function splitAtCacheBoundary(text: string): SplitPrompt {
  const idx = text.indexOf(CACHE_BOUNDARY_MARKER_LINE);
  if (idx < 0) return { stablePrefix: text, dynamicSuffix: "" };
  // Trim trailing whitespace from the prefix and leading whitespace from
  // the suffix so split / re-join yields a stable byte representation.
  const before = text.slice(0, idx).replace(/\s+$/, "");
  const after = text.slice(idx + CACHE_BOUNDARY_MARKER_LINE.length).replace(/^\s+/, "");
  return { stablePrefix: before, dynamicSuffix: after };
}

// Strip the marker entirely — used before sending to providers that don't
// honour cache boundaries (so the marker doesn't show up in the model's
// view of the prompt).
export function stripCacheBoundary(text: string): string {
  let out = text;
  // Marker may appear more than once if the assembler bugs out; remove all.
  while (out.includes(CACHE_BOUNDARY_MARKER_LINE)) {
    out = out.replace(CACHE_BOUNDARY_MARKER_LINE, "");
  }
  return out;
}

// Insert text below the cache boundary so it lives in the dynamic suffix
// (won't break the cached prefix). When no boundary exists, append to end.
export function prependBelowCacheBoundary(args: {
  systemPrompt: string;
  addition: string;
}): string {
  if (!args.addition) return args.systemPrompt;
  const idx = args.systemPrompt.indexOf(CACHE_BOUNDARY_MARKER_LINE);
  if (idx < 0) return `${args.systemPrompt}\n\n${args.addition}`;
  const insertAt = idx + CACHE_BOUNDARY_MARKER_LINE.length;
  return (
    args.systemPrompt.slice(0, insertAt) +
    "\n" +
    args.addition +
    args.systemPrompt.slice(insertAt)
  );
}
