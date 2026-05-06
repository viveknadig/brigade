// Shared types for the system-prompt subsystem.

export type PromptMode = "full" | "minimal" | "none";

// One persona/context file lifted off disk — tied 1:1 to a workspace file
// (AGENTS.md, SOUL.md, …). The runtime decides ordering and budgeting.
export interface ContextFile {
  // Logical name (filename in lowercase, e.g. "agents.md").
  name: string;
  // Absolute on-disk path, used for diagnostics and cache invalidation.
  path: string;
  // File contents — sanitized, possibly truncated by the budget pass.
  content: string;
}
