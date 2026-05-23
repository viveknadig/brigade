// Tool summaries used in the system prompt's `## Tooling` section.
//
// The summaries are short, action-oriented one-liners — they tell the model
// what each tool DOES, not how it works. Verbose docs belong in the model's
// own tool-schema introspection (Pi attaches the full ToolDefinition to the
// API request); the system prompt's job is to advertise the surface area
// so the model picks the right name on the first try and doesn't invent
// aliases like `cat` or `ls -la`.
//
// Short, action-oriented summaries by tool name. When Pi adds a tool name
// we don't recognise, the renderer falls back to "no summary" and lets
// the model rely on its tool schema.

export const BRIGADE_TOOL_SUMMARIES: Record<string, string> = {
  read: "Read file contents (text or binary).",
  write: "Create or overwrite a file with new content.",
  edit: "Make precise, targeted edits to an existing file.",
  bash: "Run a shell command in the agent's working directory.",
  grep: "Search file contents for a regex pattern (ripgrep-backed).",
  find: "Find files by name or glob pattern.",
  ls: "List the contents of a directory.",
  // Primitive #4 (Memory). Recall = search; read = bounded excerpt.
  // Writing memory uses the `write` tool (memory/<today>.md), not a
  // dedicated low-level tool.
  recall_memory: "Search your durable memory (MEMORY.md + memory/*.md) before answering.",
  read_memory: "Read a bounded excerpt of a memory file found via recall_memory.",
  // Reserved for future Brigade additions — keep them documented even when
  // not yet wired so a single source-of-truth covers any tool name Pi
  // might surface via getActiveToolNames().
  apply_patch: "Apply a multi-file patch.",
  process: "Run a long-lived shell process in the background.",
  message: "Send a message on the active channel.",
};

// Resolve a one-line summary for the named tool. Falls back to a marker
// the renderer can choose to hide entirely (so unknown tools surface as
// just `- name` without a misleading invented description).
export function resolveToolSummary(name: string): string | undefined {
  const normalised = name.trim().toLowerCase();
  return BRIGADE_TOOL_SUMMARIES[normalised];
}
