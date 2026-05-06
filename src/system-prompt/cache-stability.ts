// Tiny but load-bearing helpers that keep the assembled prompt
// byte-stable across turns so Anthropic prompt-caching can hit.
//
// Two sources of churn this addresses:
//   1. CRLF line endings sneaking in from Windows-edited workspace files.
//   2. Trailing whitespace inside templated sections — easy to introduce
//      via string interpolation, invisible at a glance, but enough to bust
//      the cache.

export function normalizeStructuredPromptSection(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
}

// Capability lists (e.g. provider features) feed into per-turn template
// expansion. Lowercasing + sorting before joining means the rendered text
// doesn't reorder when the iteration order of an upstream Set/Map changes.
export function normalizeCapabilityIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}
