// src/agents/mcp/builtin-tools.ts
//
// Serve Pi's builtin tools (read / write / edit / bash / grep / ls) over the MCP
// tool-plane, so the claude-cli harness backend actually has filesystem + shell.
//
// WHY THIS IS NEEDED: `assembleBrigadeToolset` splits its output. Brigade-native
// tools come back as `customTools` (real objects with an `execute`), but the
// builtins come back only as NAMES (`builtinToolNames`) — Pi's own agent loop
// constructs them from those names. On claude-cli Pi's loop never runs, so those
// names resolve to nothing, and the binary's own Read/Write/Bash are denied
// (they would act on the throwaway temp cwd, not the operator's workspace).
// Net effect before this module: the agent on this backend could not touch a
// file or run a command, and would (correctly) say so.
//
// WHY IT IS SAFE: these tools are added to the SAME `customTools` array the MCP
// route serves, so every call runs the turn's composed `beforeToolCall` guard
// FIRST — exactly as a Pi-loop dispatch would:
//   • `bash`        → exec-gate: hard-deny list, then allowlist, then an
//                     operator approval prompt (routed to the right session via
//                     the turn's gateCtxRef). It also refuses workdir/env overrides.
//   • `write`/`edit`→ path-write guard (protected roots) + config-write guard
//                     (no shell mutation of Brigade's own state files).
//   • all           → unknown-tool guard, cmd-ism guard, loop detector.
// The tools are constructed against the TURN'S cwd, so they act on the operator's
// real workspace rather than the binary's sandbox — which is the whole point.
//
// The allowlist is the turn's own `builtinToolNames`, so a policy that strips a
// builtin (cron `toolsAllow`, a group tool policy) strips it here too.

import {
	createBashTool,
	createEditTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { AnyBrigadeTool } from "../tools/types.js";

/**
 * Per-tool factories. NOT `createCodingTools` — that helper returns only
 * read/bash/edit/write, silently omitting grep and ls, which would have shipped
 * an agent that cannot search or list. Building each by name also means we only
 * ever construct what the turn actually allows.
 */
// Each factory takes its OWN options type; we only ever pass the shapes Pi passes
// (`optionsFor`), so the call site casts rather than modelling six unions.
const BUILTIN_FACTORIES: Readonly<Record<string, (cwd: string, options?: never) => unknown>> = {
	read: createReadTool,
	write: createWriteTool,
	edit: createEditTool,
	bash: createBashTool,
	grep: createGrepTool,
	ls: createLsTool,
};

/**
 * The operator settings Pi threads into the two builtins that take options.
 *
 * Pi's own `_buildRuntime` calls `createAllToolDefinitions(cwd, { read:
 * {autoResizeImages}, bash: {commandPrefix, shellPath} })` — and passes nothing
 * for edit/write/grep/ls. Constructing them here without those options was a
 * silent behavioural fork: an operator who set a shell prefix (`set -euo
 * pipefail`) or a non-default shell would have it honoured on a Pi-loop turn and
 * ignored on a harness turn, same agent, same command.
 */
export interface BuiltinToolSettings {
	autoResizeImages?: boolean;
	commandPrefix?: string;
	shellPath?: string;
}

/** Per-tool options, shaped exactly as Pi shapes them. */
function optionsFor(name: string, s: BuiltinToolSettings): unknown {
	if (name === "read") return s.autoResizeImages === undefined ? undefined : { autoResizeImages: s.autoResizeImages };
	if (name === "bash") {
		const bash: Record<string, unknown> = {};
		if (s.commandPrefix !== undefined) bash.commandPrefix = s.commandPrefix;
		if (s.shellPath !== undefined) bash.shellPath = s.shellPath;
		return Object.keys(bash).length > 0 ? bash : undefined;
	}
	return undefined; // Pi passes nothing for edit/write/grep/ls — match it exactly.
}

/**
 * The turn's builtin tools as callable objects, restricted to `allow` — which is
 * the turn's own `builtinToolNames`, so a policy that strips a builtin (cron
 * `toolsAllow`, a group tool policy) strips it here too. We never expose a tool
 * the in-process toolset would have withheld, and never a Pi tool Brigade does
 * not enable (e.g. `find`).
 *
 * A factory that throws is skipped rather than failing the turn: the agent then
 * simply lacks that one tool instead of losing the whole plane.
 */
export function createGuardedBuiltinTools(opts: {
	cwd: string;
	allow: readonly string[];
	settings?: BuiltinToolSettings;
}): AnyBrigadeTool[] {
	if (!opts.cwd || opts.allow.length === 0) return [];
	const settings = opts.settings ?? {};
	const out: AnyBrigadeTool[] = [];
	for (const raw of opts.allow) {
		const name = raw.trim().toLowerCase();
		const factory = BUILTIN_FACTORIES[name];
		if (!factory) continue; // not a builtin (a native tool, or one Pi doesn't have)
		try {
			const options = optionsFor(name, settings);
			const tool = (options === undefined ? factory(opts.cwd) : factory(opts.cwd, options as never)) as AnyBrigadeTool;
			if (tool && typeof tool.execute === "function") out.push(tool);
		} catch {
			/* skip this builtin; the rest of the plane still works */
		}
	}
	return out;
}

/**
 * Lift the settings Pi would have applied off the live session, best-effort.
 *
 * Read defensively: `settingsManager` is Pi-internal, and a version that renames
 * or drops a getter must degrade to Pi's own defaults (both shell settings are
 * `undefined` out of the box), never throw into a turn.
 */
export function readBuiltinToolSettings(session: unknown): BuiltinToolSettings {
	const sm = (session as { settingsManager?: Record<string, unknown> } | undefined)?.settingsManager;
	if (!sm) return {};
	const call = <T>(method: string): T | undefined => {
		const fn = sm[method];
		if (typeof fn !== "function") return undefined;
		try {
			return (fn as () => T).call(sm);
		} catch {
			return undefined;
		}
	};
	const autoResizeImages = call<boolean>("getImageAutoResize");
	const commandPrefix = call<string>("getShellCommandPrefix");
	const shellPath = call<string>("getShellPath");
	return {
		...(autoResizeImages !== undefined ? { autoResizeImages } : {}),
		...(commandPrefix !== undefined ? { commandPrefix } : {}),
		...(shellPath !== undefined ? { shellPath } : {}),
	};
}
