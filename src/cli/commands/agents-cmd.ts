/**
 * `brigade agents <list|bindings|bind|unbind|add|set-identity|delete>` — the
 * seven CRUD command runners that drive the `cfg.agents` keyed map + the
 * `cfg.bindings.entries[]` routing layer.
 *
 * Brand-scrubbed lift of the reference codebase's
 * `src/commands/agents.commands.{list,bind,add,identity,delete}.ts`, adapted
 * to Brigade's surfaces:
 *
 *   - `loadConfig()` / `saveConfig()` from `core/config.ts` (NOT
 *     `replaceConfigFile`). Brigade ships its own write path with restore-
 *     env-var, top-level reordering, backup rotation, and audit logging.
 *   - `cfg.bindings.entries[]` wrapper (NOT a flat `cfg.bindings` array).
 *   - `cfg.agents.<id>` keyed map (NOT `cfg.agents.list[]`).
 *   - `resolveAgentWorkspaceDir(agentId)` / `resolveAgentDir(agentId)` /
 *     `resolveSessionsDir(agentId)` from `config/paths.ts`.
 *   - `DEFAULT_AGENT_ID` ("main") + `normalizeAgentId` from `agents/routing/
 *     session-key.ts`.
 *
 * Interactive prompts (clack wizard, readline confirm) are NOT lifted yet —
 * Brigade has no clack-prompter and the user explicitly opted for "non-
 * interactive first, interactive parity later". Every runner errors clearly
 * when a flag set requires interaction and the flag is missing.
 *
 * Each runner returns an exit code (0 success / 1 failure) — same shape as
 * `src/cli/commands/exec-cmd.ts` — and never calls `process.exit` itself so
 * a higher-level dispatcher can compose them.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listBindings } from "../../agents/routing/bindings.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../agents/routing/session-key.js";
import type { BindingEntry, BrigadeConfig } from "../../config/io.js";
import {
	resolveAgentDir,
	resolveAgentWorkspaceDir,
	resolveSessionsDir,
} from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { bootstrapWorkspace } from "../../workspace/bootstrap.js";

import {
	applyAgentBindings,
	describeBinding,
	listRouteBindings,
	parseBindingSpecs,
	removeAgentBindings,
	type AgentRouteBinding,
	type BindingChannelDescriptor,
} from "./agents-bindings.js";
import {
	applyAgentConfig,
	buildAgentSummaries,
	findAgentEntryIndex,
	identityHasValues,
	listAgentEntries,
	loadAgentIdentity,
	parseIdentityMarkdown,
	pruneAgentConfig,
	type AgentSummary,
	type BrigadeAgentIdentity,
} from "./agents-config.js";

/* ───────────────────────── runtime + helpers ───────────────────────── */

interface OutputSink {
	log: (message: string) => void;
	error: (message: string) => void;
}

// Words that the connect-mode TUI, gateway, or shell scripting would mistake
// for sentinels ("none" meaning unset, "default" colliding with the cfg
// reserved key, "null"/"undefined" being JS literals). Keep this list short —
// `main` is already covered by DEFAULT_AGENT_ID elsewhere.
const RESERVED_AGENT_IDS = new Set(["none", "null", "undefined", "default", "all", "any"]);

function defaultSink(): OutputSink {
	return {
		log: (m) => process.stdout.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	};
}

function writeJson(sink: OutputSink, payload: unknown): void {
	sink.log(JSON.stringify(payload, null, 2));
}

/** Best-effort home-relative path renderer — keeps screenshots clean. */
function shortenHomePath(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) return p;
	const abs = path.resolve(p);
	const homeAbs = path.resolve(home);
	if (abs === homeAbs) return "~";
	if (abs.startsWith(homeAbs + path.sep)) return `~${abs.slice(homeAbs.length)}`;
	return p;
}

/** Resolve user-typed path (`~`, env vars left literal, relative → cwd). */
function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (trimmed === "~") return home || trimmed;
	if (home && trimmed.startsWith("~/")) return path.resolve(home, trimmed.slice(2));
	return path.resolve(trimmed);
}

/** Look up the bundled channel catalog so parseBindingSpecs can validate. */
async function loadChannelCatalog(): Promise<BindingChannelDescriptor[]> {
	try {
		const config = loadConfig();
		const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
		const registry = await loadModules({
			modules: BUNDLED_MODULES,
			meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
		});
		return registry.channels.map((adapter) => ({ id: adapter.id }));
	} catch {
		// Catalog load is best-effort — parseBindingSpecs treats undefined as
		// "skip validation", so binding still works against an empty registry.
		return [];
	}
}

function hasAgent(cfg: BrigadeConfig, agentId: string): boolean {
	return buildAgentSummaries(cfg).some((s) => s.id === agentId);
}

function resolveTargetAgentId(
	cfg: BrigadeConfig,
	agentInput: string | undefined,
	fallbackToDefault: boolean,
): string | null {
	if (agentInput?.trim()) return normalizeAgentId(agentInput);
	if (fallbackToDefault) return normalizeAgentId(resolveDefaultAgentId(cfg));
	return null;
}

function formatBindingOwnerLine(b: AgentRouteBinding): string {
	return `${normalizeAgentId(b.agentId)} <- ${describeBinding(b)}`;
}

function formatBindingConflicts(
	conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>,
): string[] {
	return conflicts.map((c) => `${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
}

/** Render one agent-summary card for the human `agents list` output. */
function formatSummary(summary: AgentSummary): string {
	const defaultTag = summary.isDefault ? " (default)" : "";
	const header =
		summary.name && summary.name !== summary.id
			? `${summary.id}${defaultTag} (${summary.name})`
			: `${summary.id}${defaultTag}`;
	const identityParts: string[] = [];
	if (summary.identityEmoji) identityParts.push(summary.identityEmoji);
	if (summary.identityName) identityParts.push(summary.identityName);
	const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
	const identitySource =
		summary.identitySource === "identity"
			? "IDENTITY.md"
			: summary.identitySource === "config"
				? "config"
				: null;
	const lines = [`- ${header}`];
	if (identityLine) {
		lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
	}
	lines.push(`  Workspace: ${shortenHomePath(summary.workspace)}`);
	lines.push(`  Agent dir: ${shortenHomePath(summary.agentDir)}`);
	if (summary.model) lines.push(`  Model: ${summary.model}`);
	if (summary.provider) lines.push(`  Provider: ${summary.provider}`);
	lines.push(`  Routing rules: ${summary.bindings}`);
	if (summary.bindingDetails?.length) {
		lines.push("  Routing rules:");
		for (const b of summary.bindingDetails) lines.push(`    - ${b}`);
	}
	return lines.join("\n");
}

/* ───────────────────────── 1. agents list ───────────────────────── */

export async function runAgentsList(
	opts: { json?: boolean; bindings?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents list: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const summaries = buildAgentSummaries(cfg);
	const bindingMap = new Map<string, BindingEntry[]>();
	for (const b of listBindings(cfg)) {
		const id = normalizeAgentId(b.agentId);
		const list = bindingMap.get(id) ?? [];
		list.push(b);
		bindingMap.set(id, list);
	}

	if (opts.bindings) {
		for (const summary of summaries) {
			const bindings = bindingMap.get(summary.id) ?? [];
			if (bindings.length > 0) {
				summary.bindingDetails = bindings.map((b) => describeBinding(b));
			}
		}
	}

	if (opts.json) {
		// Keep the JSON contract as an array of summaries — matches OC's shape
		// and existing machine consumers. Orphans are emitted as a stderr
		// warning only (text path below handles them visibly).
		writeJson(sink, summaries);
		return 0;
	}

	const lines = ["Agents:", ...summaries.map(formatSummary)];
	lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
	const orphanDirs = findOrphanAgentDirs(summaries.map((s) => s.id));
	if (orphanDirs.length > 0) {
		lines.push("");
		lines.push(`⚠ Orphan dirs (on disk but NOT in brigade.json): ${orphanDirs.join(", ")}`);
		lines.push("  Clean up with: rm -rf ~/.brigade/agents/<id>/  (or re-register via `brigade agents add`)");
	}
	sink.log(lines.join("\n"));
	return 0;
}

// Scan ~/.brigade/agents/ for subdirs that look like agent state (have a
// workspace/ child) but whose id is NOT in cfg.agents. Catches half-created
// agents from a partial `agents add` failure, or hand-crafted dirs that
// skipped the CLI. Returns empty when the agents/ dir doesn't exist.
function findOrphanAgentDirs(configuredIds: string[]): string[] {
	const known = new Set(configuredIds);
	const agentsRoot = path.dirname(resolveAgentDir("__probe__"));
	if (!existsSync(agentsRoot)) return [];
	const orphans: string[] = [];
	try {
		const dirents = readdirSync(agentsRoot, { withFileTypes: true });
		for (const ent of dirents) {
			if (!ent.isDirectory()) continue;
			const id = ent.name;
			if (known.has(id)) continue;
			// Only flag dirs that look agent-ish (have a workspace/ subdir).
			const workspaceProbe = path.join(agentsRoot, id, "workspace");
			if (existsSync(workspaceProbe)) {
				orphans.push(id);
			}
		}
	} catch {
		// Best-effort — list shouldn't fail because of a scan error.
	}
	return orphans;
}

/* ───────────────────────── 2. agents bindings ───────────────────────── */

export async function runAgentsBindings(
	opts: { agent?: string; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents bindings: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const filterAgentId = opts.agent?.trim() ? normalizeAgentId(opts.agent) : null;
	if (opts.agent && !filterAgentId) {
		sink.error("Agent id is required.");
		return 1;
	}
	if (filterAgentId && !hasAgent(cfg, filterAgentId)) {
		sink.error(`Agent "${filterAgentId}" not found.`);
		return 1;
	}

	const filtered = listRouteBindings(cfg).filter(
		(b) => !filterAgentId || normalizeAgentId(b.agentId) === filterAgentId,
	);

	if (opts.json) {
		writeJson(
			sink,
			filtered.map((b) => ({
				agentId: normalizeAgentId(b.agentId),
				match: b.match,
				description: describeBinding(b),
			})),
		);
		return 0;
	}

	if (filtered.length === 0) {
		sink.log(filterAgentId ? `No routing bindings for agent "${filterAgentId}".` : "No routing bindings.");
		return 0;
	}

	sink.log(["Routing bindings:", ...filtered.map((b) => `- ${formatBindingOwnerLine(b)}`)].join("\n"));
	return 0;
}

/* ───────────────────────── 3. agents bind ───────────────────────── */

export async function runAgentsBind(
	opts: { agent?: string; bind?: string[]; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents bind: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const agentId = resolveTargetAgentId(cfg, opts.agent, true);
	if (!agentId) {
		sink.error("Unable to resolve agent id.");
		return 1;
	}
	if (!hasAgent(cfg, agentId)) {
		sink.error(`Agent "${agentId}" not found.`);
		return 1;
	}

	const specs = (opts.bind ?? []).map((v) => v.trim()).filter(Boolean);
	if (specs.length === 0) {
		sink.error("Provide at least one --bind <channel[:accountId]>.");
		return 1;
	}

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg, channels: catalog });
	if (parsed.errors.length > 0) {
		sink.error(parsed.errors.join("\n"));
		return 1;
	}

	const result = applyAgentBindings(cfg, parsed.bindings);
	if (result.added.length > 0 || result.updated.length > 0) {
		saveConfig(result.config);
	}

	const payload = {
		agentId,
		added: result.added.map(describeBinding),
		updated: result.updated.map(describeBinding),
		skipped: result.skipped.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts),
	};
	if (opts.json) {
		writeJson(sink, payload);
		return result.conflicts.length > 0 ? 1 : 0;
	}

	if (result.added.length > 0) {
		sink.log("Added bindings:");
		for (const b of result.added) sink.log(`- ${describeBinding(b)}`);
	} else if (result.updated.length === 0) {
		sink.log("No new bindings added.");
	}
	if (result.updated.length > 0) {
		sink.log("Updated bindings:");
		for (const b of result.updated) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.skipped.length > 0) {
		sink.log("Already present:");
		for (const b of result.skipped) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.conflicts.length > 0) {
		sink.error("Skipped bindings already claimed by another agent:");
		for (const c of result.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 4. agents unbind ───────────────────────── */

export async function runAgentsUnbind(
	opts: { agent?: string; bind?: string[]; all?: boolean; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents unbind: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const agentId = resolveTargetAgentId(cfg, opts.agent, true);
	if (!agentId) {
		sink.error("Unable to resolve agent id.");
		return 1;
	}
	if (!hasAgent(cfg, agentId)) {
		sink.error(`Agent "${agentId}" not found.`);
		return 1;
	}

	if (opts.all && (opts.bind?.length ?? 0) > 0) {
		sink.error("Use either --all or --bind, not both.");
		return 1;
	}

	if (opts.all) {
		const existing = listRouteBindings(cfg);
		const removed = existing.filter((b) => normalizeAgentId(b.agentId) === agentId);
		const kept = existing.filter((b) => normalizeAgentId(b.agentId) !== agentId);
		if (removed.length === 0) {
			if (opts.json) {
				writeJson(sink, { agentId, removed: [], missing: [], conflicts: [] });
			} else {
				sink.log(`No bindings to remove for agent "${agentId}".`);
			}
			return 0;
		}
		const next: BrigadeConfig = {
			...cfg,
			bindings: { entries: kept },
		};
		saveConfig(next);
		const payload = {
			agentId,
			removed: removed.map(describeBinding),
			missing: [] as string[],
			conflicts: [] as string[],
		};
		if (opts.json) {
			writeJson(sink, payload);
		} else {
			sink.log(`Removed ${removed.length} binding(s) for "${agentId}".`);
		}
		return 0;
	}

	const specs = (opts.bind ?? []).map((v) => v.trim()).filter(Boolean);
	if (specs.length === 0) {
		sink.error("Provide at least one --bind <channel[:accountId]> or use --all.");
		return 1;
	}

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg, channels: catalog });
	if (parsed.errors.length > 0) {
		sink.error(parsed.errors.join("\n"));
		return 1;
	}

	const result = removeAgentBindings(cfg, parsed.bindings);
	if (result.removed.length > 0) {
		saveConfig(result.config);
	}

	const payload = {
		agentId,
		removed: result.removed.map(describeBinding),
		missing: result.missing.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts),
	};
	if (opts.json) {
		writeJson(sink, payload);
		return result.conflicts.length > 0 ? 1 : 0;
	}

	if (result.removed.length > 0) {
		sink.log("Removed bindings:");
		for (const b of result.removed) sink.log(`- ${describeBinding(b)}`);
	} else {
		sink.log("No bindings removed.");
	}
	if (result.missing.length > 0) {
		sink.log("Not found:");
		for (const b of result.missing) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.conflicts.length > 0) {
		sink.error("Bindings are owned by another agent:");
		for (const c of result.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 5. agents add ───────────────────────── */

export async function runAgentsAdd(
	opts: {
		name?: string;
		workspace?: string;
		model?: string;
		provider?: string;
		agentDir?: string;
		bind?: string[];
		nonInteractive?: boolean;
		json?: boolean;
	} = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents add: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const nameInput = opts.name?.trim();
	const workspaceFlag = opts.workspace?.trim();

	if (!nameInput) {
		sink.error("Agent name is required. Usage: brigade agents add <name> [--workspace <dir>]");
		return 1;
	}

	const agentId = normalizeAgentId(nameInput);
	if (agentId === DEFAULT_AGENT_ID) {
		sink.error(`"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`);
		return 1;
	}
	if (RESERVED_AGENT_IDS.has(agentId)) {
		sink.error(
			`"${agentId}" is a reserved word and cannot be used as an agent id. Reserved: ${[...RESERVED_AGENT_IDS].join(", ")}.`,
		);
		return 1;
	}
	if (agentId !== nameInput) {
		sink.log(`Normalized agent id to "${agentId}".`);
	}
	if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
		sink.error(`Agent "${agentId}" already exists.`);
		return 1;
	}

	const workspaceDir = workspaceFlag ? resolveUserPath(workspaceFlag) : resolveAgentWorkspaceDir(agentId);
	const agentDir = opts.agentDir?.trim() ? resolveUserPath(opts.agentDir.trim()) : resolveAgentDir(agentId);
	const model = opts.model?.trim();
	const provider = opts.provider?.trim();

	let nextConfig = applyAgentConfig(cfg, {
		agentId,
		name: nameInput,
		workspace: workspaceDir,
		agentDir,
		...(model ? { model } : {}),
		...(provider ? { provider } : {}),
	});

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs: opts.bind, config: nextConfig, channels: catalog });
	if (parsed.errors.length > 0) {
		sink.error(parsed.errors.join("\n"));
		return 1;
	}
	const bindingResult =
		parsed.bindings.length > 0
			? applyAgentBindings(nextConfig, parsed.bindings)
			: { config: nextConfig, added: [] as AgentRouteBinding[], updated: [] as AgentRouteBinding[], skipped: [] as AgentRouteBinding[], conflicts: [] as Array<{ binding: AgentRouteBinding; existingAgentId: string }> };

	nextConfig = bindingResult.config;
	saveConfig(nextConfig);

	// Seed the workspace files (SOUL/IDENTITY/AGENTS/...) so the new agent
	// is ready for its first turn. Best-effort — log warnings rather than
	// fail the whole add when a template is missing.
	try {
		await bootstrapWorkspace(workspaceDir);
	} catch (err) {
		sink.error(`Workspace seeding warning: ${err instanceof Error ? err.message : String(err)}`);
	}

	const payload = {
		agentId,
		name: nameInput,
		workspace: workspaceDir,
		agentDir,
		model: model ?? null,
		provider: provider ?? null,
		bindings: {
			added: bindingResult.added.map(describeBinding),
			updated: bindingResult.updated.map(describeBinding),
			skipped: bindingResult.skipped.map(describeBinding),
			conflicts: bindingResult.conflicts.map(
				(c) => `${describeBinding(c.binding)} (agent=${c.existingAgentId})`,
			),
		},
	};
	if (opts.json) {
		writeJson(sink, payload);
		return bindingResult.conflicts.length > 0 ? 1 : 0;
	}

	sink.log(`Agent: ${agentId}`);
	sink.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
	sink.log(`Agent dir: ${shortenHomePath(agentDir)}`);
	if (model) sink.log(`Model: ${model}`);
	if (provider) sink.log(`Provider: ${provider}`);
	if (bindingResult.added.length > 0) {
		sink.log("Added bindings:");
		for (const b of bindingResult.added) sink.log(`- ${describeBinding(b)}`);
	}
	if (bindingResult.conflicts.length > 0) {
		sink.error("Skipped bindings already claimed by another agent:");
		for (const c of bindingResult.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 6. agents set-identity ───────────────────────── */

const normalizeWorkspacePath = (input: string) => path.resolve(resolveUserPath(input));

function trimOpt(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

function resolveAgentIdByWorkspace(cfg: BrigadeConfig, workspaceDir: string): string[] {
	const list = listAgentEntries(cfg);
	const ids =
		list.length > 0
			? list.map((e) => normalizeAgentId(e.id))
			: [normalizeAgentId(resolveDefaultAgentId(cfg))];
	const target = normalizeWorkspacePath(workspaceDir);
	return ids.filter((id) => normalizeWorkspacePath(resolveAgentWorkspaceDir(id)) === target);
}

async function loadIdentityFromFile(filePath: string): Promise<BrigadeAgentIdentity | null> {
	try {
		const fs = await import("node:fs/promises");
		const content = await fs.readFile(filePath, "utf8");
		const parsed = parseIdentityMarkdown(content);
		return identityHasValues(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export async function runAgentsSetIdentity(
	opts: {
		agent?: string;
		workspace?: string;
		identityFile?: string;
		fromIdentity?: boolean;
		name?: string;
		theme?: string;
		emoji?: string;
		avatar?: string;
		json?: boolean;
	} = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents set-identity: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const agentRaw = trimOpt(opts.agent);
	const nameRaw = trimOpt(opts.name);
	const emojiRaw = trimOpt(opts.emoji);
	const themeRaw = trimOpt(opts.theme);
	const avatarRaw = trimOpt(opts.avatar);
	const hasExplicitIdentity = Boolean(nameRaw || emojiRaw || themeRaw || avatarRaw);

	const identityFileRaw = trimOpt(opts.identityFile);
	const workspaceRaw = trimOpt(opts.workspace);
	const wantsIdentityFile = Boolean(opts.fromIdentity || identityFileRaw || !hasExplicitIdentity);

	let identityFilePath: string | undefined;
	let workspaceDir: string | undefined;
	if (identityFileRaw) {
		identityFilePath = normalizeWorkspacePath(identityFileRaw);
		workspaceDir = path.dirname(identityFilePath);
	} else if (workspaceRaw) {
		workspaceDir = normalizeWorkspacePath(workspaceRaw);
	} else if (wantsIdentityFile || !agentRaw) {
		workspaceDir = path.resolve(process.cwd());
	}

	let agentId = agentRaw ? normalizeAgentId(agentRaw) : undefined;
	if (!agentId) {
		if (!workspaceDir) {
			sink.error("Select an agent with --agent or provide a workspace via --workspace.");
			return 1;
		}
		const matches = resolveAgentIdByWorkspace(cfg, workspaceDir);
		if (matches.length === 0) {
			sink.error(
				`No agent workspace matches ${shortenHomePath(workspaceDir)}. Pass --agent to target a specific agent.`,
			);
			return 1;
		}
		if (matches.length > 1) {
			sink.error(
				`Multiple agents match ${shortenHomePath(workspaceDir)}: ${matches.join(", ")}. Pass --agent to choose one.`,
			);
			return 1;
		}
		agentId = matches[0] as string;
	}

	let identityFromFile: BrigadeAgentIdentity | null = null;
	if (wantsIdentityFile) {
		if (identityFilePath) {
			identityFromFile = await loadIdentityFromFile(identityFilePath);
		} else if (workspaceDir) {
			identityFromFile = loadAgentIdentity(workspaceDir);
		}
		if (!identityFromFile) {
			const targetPath =
				identityFilePath ??
				(workspaceDir ? path.join(workspaceDir, "IDENTITY.md") : "IDENTITY.md");
			sink.error(`No identity data found in ${shortenHomePath(targetPath)}.`);
			return 1;
		}
	}

	const fileTheme = identityFromFile?.theme ?? identityFromFile?.creature ?? identityFromFile?.vibe ?? undefined;
	const incomingIdentity: BrigadeAgentIdentity = {
		...(nameRaw || identityFromFile?.name ? { name: nameRaw ?? identityFromFile?.name } : {}),
		...(emojiRaw || identityFromFile?.emoji ? { emoji: emojiRaw ?? identityFromFile?.emoji } : {}),
		...(themeRaw || fileTheme ? { theme: themeRaw ?? fileTheme } : {}),
		...(avatarRaw || identityFromFile?.avatar
			? { avatar: avatarRaw ?? identityFromFile?.avatar }
			: {}),
	};

	if (
		!incomingIdentity.name &&
		!incomingIdentity.emoji &&
		!incomingIdentity.theme &&
		!incomingIdentity.avatar
	) {
		sink.error("No identity fields provided. Use --name/--emoji/--theme/--avatar or --from-identity.");
		return 1;
	}

	const nextConfig = applyAgentConfig(cfg, {
		agentId,
		identity: incomingIdentity,
	});
	saveConfig(nextConfig);

	if (opts.json) {
		writeJson(sink, {
			agentId,
			identity: incomingIdentity,
			workspace: workspaceDir ?? null,
			identityFile: identityFilePath ?? null,
		});
		return 0;
	}

	sink.log(`Agent: ${agentId}`);
	if (incomingIdentity.name) sink.log(`Name: ${incomingIdentity.name}`);
	if (incomingIdentity.theme) sink.log(`Theme: ${incomingIdentity.theme}`);
	if (incomingIdentity.emoji) sink.log(`Emoji: ${incomingIdentity.emoji}`);
	if (incomingIdentity.avatar) sink.log(`Avatar: ${incomingIdentity.avatar}`);
	if (workspaceDir) sink.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
	return 0;
}

/* ───────────────────────── 7. agents delete ───────────────────────── */

/** Best-effort rm — never throws; logs the failure when verbose. */
function safeRm(target: string, sink: OutputSink): void {
	if (!existsSync(target)) return;
	try {
		rmSync(target, { recursive: true, force: true });
	} catch (err) {
		sink.error(
			`Warning: failed to remove ${shortenHomePath(target)}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function runAgentsDelete(
	opts: { id: string; force?: boolean; json?: boolean },
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		sink.error(`brigade agents delete: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const input = opts.id?.trim();
	if (!input) {
		sink.error("Agent id is required.");
		return 1;
	}
	const agentId = normalizeAgentId(input);
	if (agentId !== input) sink.log(`Normalized agent id to "${agentId}".`);
	if (agentId === DEFAULT_AGENT_ID) {
		sink.error(`"${DEFAULT_AGENT_ID}" cannot be deleted.`);
		return 1;
	}
	if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
		sink.error(`Agent "${agentId}" not found.`);
		return 1;
	}

	if (!opts.force) {
		sink.error(
			`Refusing to delete agent "${agentId}" without --force. (Interactive confirm ships in a follow-up.)`,
		);
		return 1;
	}

	const workspaceDir = resolveAgentWorkspaceDir(agentId);
	const agentDir = resolveAgentDir(agentId);
	const sessionsDir = resolveSessionsDir(agentId);

	const result = pruneAgentConfig(cfg, agentId);
	saveConfig(result.config);

	safeRm(workspaceDir, sink);
	safeRm(agentDir, sink);
	safeRm(sessionsDir, sink);

	if (opts.json) {
		writeJson(sink, {
			agentId,
			workspace: workspaceDir,
			agentDir,
			sessionsDir,
			removedBindings: result.removedBindings,
			removedAllow: result.removedAllow,
		});
	} else {
		sink.log(`Deleted agent: ${agentId}`);
		if (result.removedBindings > 0) sink.log(`Removed ${result.removedBindings} routing binding(s).`);
		if (result.removedAllow > 0) sink.log(`Removed ${result.removedAllow} agent-to-agent allow pair(s).`);
	}
	return 0;
}
