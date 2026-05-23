/**
 * Brigade extension loader — runs modules into a registry, gated by config + env.
 *
 * Loads bundled (in-tree) modules PLUS user modules discovered under
 * `~/.brigade/extensions/`. Gating mirrors the plugins/skills model: global
 * `extensions.enabled`, an `allow` allowlist, a `disabled` deny-list, per-module
 * `entries[id].enabled`, each module's own `requiresEnv` + `eligible()` check,
 * and per-module `configSchema` validation of `entries[id].config`. A module
 * that throws (or fails validation) is skipped, never fatal. Bundled modules win
 * id conflicts with user modules (a user module can't shadow a core capability).
 *
 * Activation traceability: EVERY module decision (activated / skipped) emits a
 * structured log line under the `extensions/loader` subsystem. The reason is a
 * stable enum (`disabled`/`requiresEnv`/`eligible`/`allowlist`/`configSchema`/
 * `registerFailed`) so an operator running `brigade doctor` or scraping the
 * JSONL log can answer "why didn't my plugin load" without source-diving.
 */

import { Check, Errors } from "typebox/value";

import type { BrigadeConfig } from "../../config/io.js";
import { resolveExtensionsDir } from "../../config/paths.js";
import { withTimeout } from "../../core/extension-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { discoverUserModules, type DiscoveredModule } from "./discovery.js";
import { BrigadeExtensionRegistry, type RegistryContextMeta } from "./registry.js";
import type { BrigadeModule } from "./types.js";

const log = createSubsystemLogger("extensions/loader");

// A module's register() should just record capabilities and return; cap it so a
// buggy/hung one can't wedge boot or a turn.
const REGISTER_TIMEOUT_MS = 10_000;

interface ExtensionEntryView {
	enabled?: boolean;
	config?: unknown;
}

interface ExtensionsConfigView {
	enabled?: boolean;
	allow?: string[];
	disabled?: string[];
	entries?: Record<string, ExtensionEntryView>;
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
	/** Override the user-extensions dir (tests); defaults to `~/.brigade/extensions`. */
	extensionsDir?: string;
	/** Skip filesystem discovery of user modules (tests / bundled-only callers). */
	noDiscovery?: boolean;
}

/** Per-module decision tag the loader emits on every load attempt. */
type ActivationReason =
	| "disabled"
	| "requiresEnv"
	| "eligible"
	| "allowlist"
	| "configSchema"
	| "registerFailed";

/**
 * Run the eligible modules into a fresh registry. Returns the populated
 * registry; the list of modules that actually registered is on
 * `registry.loadedModules` (for reload). Agent-level capabilities come back via
 * `toPiExtensionFactory()`, product-level via the getters.
 */
export async function loadModules(args: LoadModulesArgs): Promise<BrigadeExtensionRegistry> {
	const registry = new BrigadeExtensionRegistry();
	const config = args.meta.config;
	const ext = extensionsConfig(config);
	if (ext?.enabled === false) {
		return registry; // subsystem globally disabled → empty
	}
	const env = args.env ?? process.env;
	const disabled = resolveDisabled(config);
	const allow = ext?.allow ?? [];
	const entries = ext?.entries ?? {};

	// Bundled first; then user modules (deduped — a bundled id wins).
	const bundledIds = new Set(args.modules.map((m) => m.id));
	const userModules: DiscoveredModule[] = [];
	if (!args.noDiscovery) {
		const discovered = await discoverUserModules(args.extensionsDir ?? resolveExtensionsDir());
		for (const d of discovered) {
			if (bundledIds.has(d.module.id)) {
				log.warn("user extension shadows a bundled module id — ignoring the user one", {
					id: d.module.id,
					source: d.source,
				});
				continue;
			}
			userModules.push(d);
		}
	}

	// Pair each module with its origin/source so the activation log can record
	// provenance for both bundled and user modules.
	type Decision = { module: BrigadeModule; origin: "bundled" | "user"; source?: string };
	const all: Decision[] = [
		...args.modules.map<Decision>((m) => ({ module: m, origin: "bundled" })),
		...userModules.map<Decision>((d) => ({ module: d.module, origin: "user", source: d.source })),
	];

	for (const { module: m, origin, source } of all) {
		if (disabled.has(m.id)) {
			logSkip(m.id, origin, source, "disabled", "extensions.disabled[] or entries[id].enabled=false");
			continue;
		}
		// Allowlist: when non-empty, only listed modules load.
		if (allow.length > 0 && !allow.includes(m.id)) {
			logSkip(m.id, origin, source, "allowlist", "extensions.allow does not include this id");
			continue;
		}
		if (m.requiresEnv) {
			const missing = m.requiresEnv.find((v) => !env[v] || env[v]?.trim() === "");
			if (missing) {
				logSkip(m.id, origin, source, "requiresEnv", `missing ${missing}`);
				continue;
			}
		}
		if (m.eligible && !m.eligible({ config, env })) {
			logSkip(m.id, origin, source, "eligible", "eligible() returned false");
			continue;
		}

		// Per-module config-schema validation against entries[id].config.
		const moduleConfig = entries[m.id]?.config;
		if (m.configSchema && !Check(m.configSchema, moduleConfig ?? {})) {
			// Surface the first validation error so the operator knows WHAT to set.
			const first = Errors(m.configSchema, moduleConfig ?? {})[0] as { path?: string; message?: string } | undefined;
			logSkip(
				m.id,
				origin,
				source,
				"configSchema",
				`config invalid at ${first?.path ?? "<root>"}: ${first?.message ?? "validation error"}`,
			);
			continue;
		}

		try {
			// Time-box register so a hung module (e.g. a stray network await) can't
			// wedge boot or the per-turn path. A well-behaved register just records
			// and resolves instantly.
			await withTimeout(
				Promise.resolve(m.register(registry.context({ ...args.meta, moduleConfig }))),
				REGISTER_TIMEOUT_MS,
				`module ${m.id} register`,
			);
			registry.loadedModules.push(m);
			log.info("extension activated", { id: m.id, origin, source });
		} catch (err) {
			logSkip(
				m.id,
				origin,
				source,
				"registerFailed",
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return registry;
}

/**
 * Emit a stable, structured `extension skipped` log line. The shape is
 * deliberately fixed (`id`/`origin`/`source`/`reason`/`cause`) so a future
 * `brigade doctor` UI can render skip explanations without source-diving.
 */
function logSkip(
	id: string,
	origin: "bundled" | "user",
	source: string | undefined,
	reason: ActivationReason,
	cause: string,
): void {
	const fields: Record<string, unknown> = { id, origin, reason, cause };
	if (source) fields.source = source;
	// `registerFailed` is a real error (the module threw); everything else is a
	// configured skip and stays at warn so it doesn't drown an operator who's
	// just running a constrained allowlist.
	if (reason === "registerFailed") {
		log.warn("extension register failed", fields);
	} else {
		log.info("extension skipped", fields);
	}
}
