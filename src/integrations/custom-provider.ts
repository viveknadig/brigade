/**
 * Custom (catalog-defined) provider registration.
 *
 * Some providers ship a key + a known Anthropic-compatible (or OpenAI-
 * compatible) endpoint we already know from the catalog — GLM, Kimi, Qwen,
 * MiniMax, DeepSeek. Pi-AI doesn't bundle these as built-in providers, so we
 * register them dynamically via the `~/.brigade/models.json` mechanism, the
 * same way Ollama is registered. Each catalog model id becomes a Pi model
 * routed through the provider's `baseUrl` + `api`.
 *
 * We MERGE rather than overwrite — the user (or other providers) may have
 * existing entries in the file we shouldn't clobber.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

import { tryGetRuntimeContext } from "../storage/runtime-context.js";

export async function writeCustomProviderToModelsJson(
	modelsJsonPath: string,
	p: {
		id: string;
		baseUrl: string;
		api: "openai-completions" | "anthropic-messages";
		apiKey: string;
		models: string[];
	},
): Promise<void> {
	let existing: { providers?: Record<string, any> } = { providers: {} };
	try {
		const raw = await fs.readFile(modelsJsonPath, "utf8");
		existing = JSON.parse(raw);
		if (!existing.providers) existing.providers = {};
	} catch {
		// File missing or unparseable — start fresh. Pi treats an absent file as no config.
	}

	existing.providers![p.id] = {
		baseUrl: p.baseUrl,
		api: p.api,
		apiKey: p.apiKey,
		models: p.models.map((id) => ({ id, name: id })),
	};

	// In convex mode resolveModelsPath routes to the OS cache dir, which may
	// not exist yet on a fresh machine — a bare write would ENOENT. Filesystem
	// mode: ~/.brigade always exists by this point, so the mkdir is a no-op.
	await fs.mkdir(path.dirname(modelsJsonPath), { recursive: true });
	await fs.writeFile(modelsJsonPath, JSON.stringify(existing, null, 2), "utf8");

	// The coding-plan apiKey is written PLAINTEXT into models.json. Lock the
	// file down to owner-only on POSIX so a shared-host neighbour can't read the
	// key (mirrors the `chmodIfPosix` pattern in src/auth/profiles.ts). No-op on
	// Windows (NTFS perms model differs) and best-effort on filesystems that
	// don't support chmod (e.g. mounted FAT32).
	if (process.platform !== "win32") {
		try {
			await fs.chmod(modelsJsonPath, 0o600);
		} catch {
			// Filesystem may not support chmod — non-fatal.
		}
	}

	// Convex mode — the file just written lives in the OS cache (resolveModelsPath
	// routed it there) and is a regenerable mirror; the durable copy is the
	// sealed "models" blob. Push it so a fresh machine re-materialises the
	// catalog at boot.
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		await rctx.store.auth
			.writeAuthFileBlob("main", "models" as never, existing as Record<string, unknown>)
			.catch((err: Error) => {
				console.error(`brigade: models catalog write to convex failed — ${err.message}`);
			});
	}
}
