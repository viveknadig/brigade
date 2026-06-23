/**
 * SDK-alias map for user-authored extension modules.
 *
 * A module dropped into `~/.brigade/extensions/` imports Brigade's stable
 * authoring surface by specifier — `brigade/extension-sdk` and
 * `brigade/channel-sdk` (plus the real package-name forms
 * `@spinabot/brigade/extension-sdk` and `@spinabot/brigade/channel-sdk`) —
 * WITHOUT installing Brigade into that folder. This module builds the alias map
 * that points those specifiers at Brigade's OWN built SDK entry points, and
 * hands back a configured Jiti instance so the user module loads (and transpiles
 * if it's TypeScript) against the same SDK Brigade ships.
 *
 * Resolution is RELATIVE to this file, so it works in both layouts:
 *   - built runtime: `dist/agents/extensions/sdk-alias.js` → `dist/extension-sdk.js`
 *   - dev/source:    `src/agents/extensions/sdk-alias.ts`  → `src/extension-sdk.ts`
 * We never hard-code the file extension — Jiti resolves `.js`/`.ts`/`.mts`/… —
 * we only locate the on-disk SDK file and alias the specifiers to it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

/** Specifier forms an author may use to reach a given SDK entry point. */
const EXTENSION_SDK_SPECIFIERS = ["brigade/extension-sdk", "@spinabot/brigade/extension-sdk"] as const;
const CHANNEL_SDK_SPECIFIERS = ["brigade/channel-sdk", "@spinabot/brigade/channel-sdk"] as const;

/** Candidate extensions Jiti can load a Brigade SDK entry from, most-built first. */
const SDK_ENTRY_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;

/**
 * Jiti's `alias` values must be plain forward-slash paths even on Windows; raw
 * `C:\...\file.ts` targets are mishandled by the resolver. Normalize here.
 */
function normalizeAliasTarget(target: string): string {
	return process.platform === "win32" ? target.replace(/\\/g, "/") : target;
}

/**
 * Resolve the on-disk SDK entry whose extensionless base is `baseNoExt`
 * (e.g. `<root>/extension-sdk`). Returns the first matching file, preferring a
 * built `.js` over a source `.ts` so the production runtime stays on the
 * canonical built module graph; falls back to the bare base (letting Jiti
 * resolve) when nothing is found on disk.
 */
function resolveSdkEntryFile(baseNoExt: string): string {
	for (const ext of SDK_ENTRY_EXTENSIONS) {
		const candidate = `${baseNoExt}${ext}`;
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return baseNoExt;
}

/**
 * Build the specifier → absolute-path alias map that lets a user extension
 * `import { defineModule, ... } from "brigade/extension-sdk"` (or
 * `"brigade/channel-sdk"`) without Brigade installed locally.
 *
 * `moduleDir` defaults to this file's directory; tests may override it. The SDK
 * entries live two levels up (`extension-sdk` / `channel-sdk` at the package
 * src/dist root), mirroring the `./extension-sdk` + `./channel-sdk` package
 * exports.
 */
export function buildExtensionSdkAliasMap(moduleDir?: string): Record<string, string> {
	const baseDir = moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
	const sdkRoot = path.resolve(baseDir, "..", "..");
	const extensionSdkTarget = normalizeAliasTarget(resolveSdkEntryFile(path.join(sdkRoot, "extension-sdk")));
	const channelSdkTarget = normalizeAliasTarget(resolveSdkEntryFile(path.join(sdkRoot, "channel-sdk")));
	const aliasMap: Record<string, string> = {};
	for (const specifier of EXTENSION_SDK_SPECIFIERS) {
		aliasMap[specifier] = extensionSdkTarget;
	}
	for (const specifier of CHANNEL_SDK_SPECIFIERS) {
		aliasMap[specifier] = channelSdkTarget;
	}
	return aliasMap;
}

export type ExtensionSdkJiti = ReturnType<typeof createJiti>;

/**
 * Create a Jiti instance configured to load a user extension: it applies the
 * SDK alias (so `brigade/extension-sdk` / `brigade/channel-sdk` resolve), and
 * transpiles TypeScript (`.ts`/`.mts`) entries on import. `interopDefault`
 * unwraps `export default` to a plain value so the discovery layer's
 * `default`/`module` extraction keeps working.
 *
 * `parentUrl` is the importer URL Jiti resolves relative paths against — pass
 * this module's `import.meta.url` so the alias targets (absolute paths) and any
 * sibling resolution behave consistently. `moduleDir` overrides the directory
 * used to locate the SDK entries (tests only).
 */
export function createExtensionSdkJiti(parentUrl: string, moduleDir?: string): ExtensionSdkJiti {
	return createJiti(parentUrl, {
		interopDefault: true,
		alias: buildExtensionSdkAliasMap(moduleDir),
		extensions: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
	});
}
