/**
 * Workspace path jail — refuses tool calls that try to write or shell
 * outside the agent's workspace directory.
 *
 * Wired into Pi's `session.agent.beforeToolCall` hook AFTER the
 * unknown-tool guard. The two guards are composed in `agent-loop.ts`:
 * unknown-tool first (name validation), then workspace-jail (path
 * validation for path-taking tools).
 *
 * Three policies, one per risk level:
 *
 *   1. WRITES (`write`, `edit`) — path MUST resolve inside the workspace
 *      root. Relative paths are resolved against the workspace root, NOT
 *      the process cwd, so a tool call like `write({path: "USER.md"})`
 *      lands at `<workspace>/USER.md` — exactly what the BOOTSTRAP
 *      script expects. Absolute paths must be inside the workspace
 *      root. `..` traversal escapes are blocked.
 *
 *   2. SHELL (`bash`) — refused entirely in this layer. There is no
 *      command-pattern allowlist, no approval flow, no per-pattern
 *      caching in v1. The proper exec-policy layer ships in Primitive
 *      #3 alongside TypeBox schemas + before/after hooks. Until then,
 *      shell is gated off so a turn cannot run arbitrary commands
 *      against the user's host.
 *
 *   3. READ-ONLY (`read`, `grep`, `find`, `ls`) — left open. These
 *      cannot mutate state, and the "AI lives inside your workspace"
 *      UX leans on the agent being able to inspect surrounding code.
 *      Primitive #3 may add finer-grained read-scope policies; v1
 *      keeps them broad to preserve the working flow.
 *
 * Why a separate guard rather than a wrapper around `makeUnknownToolGuard`:
 * the two guards have different concerns (name vs args) and may evolve
 * independently — e.g. a future shell-allowlist guard would slot in here
 * without touching unknown-tool semantics.
 */

import * as path from "node:path";

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/**
 * Tools whose `path` argument is restricted to inside the workspace.
 * Adding a new mutating tool? Put it here too.
 */
const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * Tools that are refused outright in v1. Until Primitive #3 ships
 * proper exec-policy + approval flow, blanket-deny rather than open
 * an unbounded shell to the host.
 */
const REFUSED_IN_V1 = new Set(["bash"]);

/**
 * Resolve a path argument against the workspace root, normalizing `~`,
 * relative segments, and `..` traversal. Returns the absolute resolved
 * path. Does NOT verify the result is inside the workspace — that's
 * what `isPathInsideWorkspace` does.
 */
export function resolveAgainstWorkspace(rawPath: string, workspaceRoot: string): string {
	if (!rawPath) return path.resolve(workspaceRoot);
	const expanded = rawPath.startsWith("~")
		? rawPath.replace(/^~(?=$|[/\\])/, () => process.env.HOME ?? process.env.USERPROFILE ?? "~")
		: rawPath;
	if (path.isAbsolute(expanded)) return path.resolve(expanded);
	return path.resolve(workspaceRoot, expanded);
}

/**
 * Is `candidate` (a possibly-relative path) inside `workspaceRoot`
 * after normalization? Returns true iff the resolved path is `root`
 * itself or a descendant of `root`. Symlink alias escapes are NOT
 * checked here — Primitive #3 will add a separate alias guard if we
 * decide it's worth the syscall cost on every call.
 *
 * Case sensitivity follows the platform: Windows path comparisons are
 * case-insensitive (workspace `C:\Users\...` vs candidate `c:\users\...`
 * both match), POSIX comparisons stay case-sensitive.
 */
export function isPathInsideWorkspace(candidate: string, workspaceRoot: string): boolean {
	const resolvedCandidate = resolveAgainstWorkspace(candidate, workspaceRoot);
	const resolvedRoot = path.resolve(workspaceRoot);
	const rel = path.relative(resolvedRoot, resolvedCandidate);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

/**
 * Build a `beforeToolCall` hook that enforces the three policies above.
 * Compose with `makeUnknownToolGuard` at the call site:
 *
 *   const nameGuard = makeUnknownToolGuard(enabledToolNames);
 *   const jailGuard = makeWorkspaceJailGuard(workspaceRoot);
 *   session.agent.beforeToolCall = async (ctx, signal) => {
 *     return (await nameGuard(ctx, signal)) ?? (await jailGuard(ctx, signal));
 *   };
 */
export function makeWorkspaceJailGuard(workspaceRoot: string): BrigadeBeforeToolCallHook {
	const root = path.resolve(workspaceRoot);
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim() : "";
		if (!name) return undefined;

		if (REFUSED_IN_V1.has(name)) {
			return {
				block: true,
				reason:
					`Tool "${name}" is disabled in this build. Shell access is gated until ` +
					`the exec-policy layer ships. If you need to inspect the workspace, ` +
					`use "read", "grep", "find", or "ls" instead.`,
			};
		}

		if (!PATH_MUTATING_TOOLS.has(name)) return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; args?: unknown; arguments?: unknown })
			?.toolCall?.arguments
			?? (ctx as { args?: unknown })?.args
			?? (ctx as { arguments?: unknown })?.arguments
			?? {};

		if (!args || typeof args !== "object") return undefined;
		const candidate = (args as { path?: unknown }).path;
		if (typeof candidate !== "string" || candidate.length === 0) return undefined;

		if (!isPathInsideWorkspace(candidate, root)) {
			const resolved = resolveAgainstWorkspace(candidate, root);
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: path "${candidate}" resolves to "${resolved}" ` +
					`which is outside the workspace "${root}". Persona files (USER.md, ` +
					`IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, BOOTSTRAP.md, HEARTBEAT.md, ` +
					`MEMORY.md) belong inside the workspace — use a relative path like ` +
					`"USER.md" and the tool will resolve it against the workspace root.`,
			};
		}
		return undefined;
	};
}
