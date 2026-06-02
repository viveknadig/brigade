/**
 * Bundled channel-entry contract + factory.
 *
 * Brand-scrubbed analogue of upstream's `src/plugin-sdk/channel-entry-contract.ts`,
 * trimmed to what Brigade's plugin loader needs today. The factory
 * (`defineBundledChannelEntry`) emits a `BundledChannelEntryContract`
 * descriptor object that:
 *
 *   1. Identifies the plugin (`id`, `name`, `description`).
 *   2. Hands the loader a lazy `loadChannelPlugin()` accessor that
 *      returns the `ChannelPlugin` definition only when the plugin is
 *      activated (avoids paying for unused channel imports at boot).
 *   3. Optionally surfaces `loadChannelSecrets()` and
 *      `setChannelRuntime()` for plugins that need secret-target
 *      registration + per-runtime side effects respectively.
 *
 * What Brigade DOES NOT do here (deferred to Pi 0.73 native extension
 * engine + Step 16):
 *
 *   - It does NOT load the module from disk — that's the Pi engine's
 *     job. The factory receives a direct `loadChannelPlugin` callable
 *     instead of a `{ specifier, exportName }` import descriptor.
 *
 *   - It does NOT register with a `BrigadePluginApi` (no such object
 *     exists yet in Brigade — Pi 0.73 owns plugin registration). The
 *     factory just emits the descriptor; the Pi-side adapter consumes
 *     it.
 *
 * Channel plugin authors call this once per plugin (typically from
 * `extensions/<name>/index.ts`) and `export default` the result.
 */

import type { ChannelPlugin } from "./types.plugin.js";

export type ChannelPluginRuntime = {
	logger?: {
		info?: (message: string, meta?: Record<string, unknown>) => void;
		warn?: (message: string, meta?: Record<string, unknown>) => void;
		error?: (message: string, meta?: Record<string, unknown>) => void;
	};
	[key: string]: unknown;
};

export interface DefineBundledChannelEntryOptions<TPlugin = ChannelPlugin> {
	/** Kebab-case plugin id; must match `plugin.id`. */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** One-line description. */
	description: string;
	/** Lazy accessor for the channel plugin module. */
	loadChannelPlugin: () => TPlugin;
	/** Optional accessor for secret-target registry entries. */
	loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
	/** Optional runtime initialiser called once on first plugin activation. */
	setChannelRuntime?: (runtime: ChannelPluginRuntime) => void;
}

export interface BundledChannelEntryContract<TPlugin = ChannelPlugin> {
	kind: "bundled-channel-entry";
	id: string;
	name: string;
	description: string;
	loadChannelPlugin: () => TPlugin;
	loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
	setChannelRuntime?: (runtime: ChannelPluginRuntime) => void;
}

/**
 * Factory consumed by every bundled channel extension. Returns a
 * descriptor the Pi-side plugin engine adapter (Step 16) registers
 * against the gateway.
 */
export function defineBundledChannelEntry<TPlugin = ChannelPlugin>(
	opts: DefineBundledChannelEntryOptions<TPlugin>,
): BundledChannelEntryContract<TPlugin> {
	return {
		kind: "bundled-channel-entry",
		id: opts.id,
		name: opts.name,
		description: opts.description,
		loadChannelPlugin: opts.loadChannelPlugin,
		...(opts.loadChannelSecrets ? { loadChannelSecrets: opts.loadChannelSecrets } : {}),
		...(opts.setChannelRuntime ? { setChannelRuntime: opts.setChannelRuntime } : {}),
	};
}
