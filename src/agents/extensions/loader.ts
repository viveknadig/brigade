/**
 * Brigade extension loader — runs modules into a registry, gated by config + env.
 *
 * Bundled (in-tree) modules are passed in; user modules under
 * `~/.brigade/extensions/` will be discovered + dynamic-imported here later (same
 * gating). Gating mirrors the skills/plugins model: global `extensions.enabled`,
 * a `disabled` deny-list, per-module `entries[id].enabled`, plus each module's
 * own `requiresEnv` + `eligible()` check. A module that throws is skipped, never
 * fatal.
 */

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import type { BrigadeConfig } from "../../config/io.js";
import { BrigadeExtensionRegistry, type RegistryContextMeta } from "./registry.js";
import type { BrigadeModule } from "./types.js";

const log = createSubsystemLogger("extensions/loader");

interface ExtensionsConfigView {
	enabled?: boolean;
	disabled?: string[];
	entries?: Record<string, { enabled?: boolean }>;
}

function extensionsConfig(config: BrigadeConfig): ExtensionsConfigView | undefined {
	return (config as { extensions?: ExtensionsConfigView }).extensions;
}

/** Module ids disabled via `extensions.disabled[]` or `extensions.entries[id].enabled === false`. */
function resolveDisabled(config: BrigadeConfig): Set<string> {
	const out = new Set<string>();
	const ext = extensionsConfig(config);
	for (const id of ext?.disabled ?? []) out.add(id);
	for (const [id, entry] of Object.entries(ext?.entries ?? {})) {
		if (entry && entry.enabled === false) out.add(id);
	}
	return out;
}

export interface LoadModulesArgs {
	/** Bundled (in-tree) modules to load. */
	modules: BrigadeModule[];
	meta: RegistryContextMeta;
	/** Injected env for gating (tests); defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Run the given modules into a fresh registry. Returns the populated registry:
 * agent-level via `toPiExtensionFactory()`, product-level via the getters.
 * Synchronous-ish (module `register` may be async; awaited in order).
 */
export async function loadModules(args: LoadModulesArgs): Promise<BrigadeExtensionRegistry> {
	const registry = new BrigadeExtensionRegistry();
	if (extensionsConfig(args.meta.config)?.enabled === false) {
		return registry; // subsystem globally disabled → empty
	}
	const ctx = registry.context(args.meta);
	const env = args.env ?? process.env;
	const disabled = resolveDisabled(args.meta.config);

	for (const m of args.modules) {
		if (disabled.has(m.id)) continue;
		if (m.requiresEnv && m.requiresEnv.some((v) => !env[v] || env[v]?.trim() === "")) continue;
		if (m.eligible && !m.eligible({ config: args.meta.config, env })) continue;
		try {
			await m.register(ctx);
		} catch (err) {
			log.warn("extension module register failed", {
				module: m.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return registry;
}
