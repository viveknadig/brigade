/**
 * Provider auth-method factories — the canonical implementations of the
 * `ProviderAuthMethod` contract. Provider plugins (Anthropic, OpenAI, future
 * OAuth-only providers, etc.) call these helpers from their `register(b)` to
 * declare WHICH auth flows they support without re-implementing env-var
 * sniffing or interactive prompts.
 *
 * Today the runtime only consumes the bundled API-key flow in
 * `ui/onboarding.ts`; this file lands the shape so a provider plugin shipping
 * OAuth or a CLI-token flow can register against the same interface without
 * a downstream rewrite. The migration from the hand-rolled `ensureApiKey`
 * path to plugin-registered auth methods happens in a follow-up — when the
 * first non-API-key provider plugin ships.
 *
 * Brigade-native naming: the factories live under `providers/` (parallel to
 * `catalog.ts` + `validate-key.ts`) and follow Brigade's `create*` convention
 * for stateless helper constructors.
 */

import { createInterface } from "node:readline";

import type { ProviderAuthMethod } from "../agents/extensions/types.js";

/** Result returned by an auth-method `validate` callback. */
export type ApiKeyValidationOutcome = { ok: true } | { ok: false; reason: string };

/* ─────────────────────────── API-key auth method ─────────────────────────── */

/**
 * Build a `ProviderAuthMethod` that captures + resolves an API-key credential.
 *
 * `runNonInteractive` walks `[envVar, ...envVarFallbacks]` against the supplied
 * `env` map and returns the first non-empty hit (trimmed) tagged with the env
 * var it came from. `null` means "no key in env" — the caller decides whether
 * to fall through to the interactive prompt or bail.
 *
 * `run` is the interactive prompt invoked by the onboarding wizard. It reads
 * one line from stdin via `node:readline`, optionally calls `validate(key)` to
 * confirm the key is live, and returns the credential record on success (or
 * `null` when the operator submits an empty line / cancels).
 */
export function createApiKeyAuthMethod(opts: {
	/** Auth-method id — defaults to `"api-key"`; override when a provider
	 *  exposes more than one API-key flavour (e.g. `"api-key-classic"` vs
	 *  `"api-key-admin"`). */
	id?: string;
	/** Human label shown in the picker, e.g. `"Anthropic API key"`. */
	label?: string;
	/** Primary env var to consult during non-interactive resolution. */
	envVar: string;
	/** Additional env vars consulted when the primary is unset (in order). */
	envVarFallbacks?: string[];
	/** Prompt text shown to the operator during interactive `run`. */
	promptText?: string;
	/** Optional live-validation callback. When provided, `run` rejects keys
	 *  the validator marks `{ ok: false }` and re-surfaces the reason via
	 *  the logger. Skip to accept any non-empty input. */
	validate?: (key: string) => Promise<ApiKeyValidationOutcome>;
}): ProviderAuthMethod {
	const label = opts.label ?? "API key";
	const id = opts.id ?? "api-key";
	const promptText = opts.promptText ?? `Enter your ${label}: `;

	return {
		id,
		label,
		kind: "api_key",

		runNonInteractive: async ({ env }) => {
			const candidates = [opts.envVar, ...(opts.envVarFallbacks ?? [])];
			for (const key of candidates) {
				const raw = env[key];
				if (typeof raw !== "string") continue;
				const trimmed = raw.trim();
				if (trimmed.length === 0) continue;
				return { apiKey: trimmed, source: "env", envVar: key };
			}
			return null;
		},

		run: async ({ logger }) => {
			const answer = await readLine(promptText);
			if (answer === null) return null;
			const trimmed = answer.trim();
			if (trimmed.length === 0) {
				logger(`No ${label} entered — cancelled.`);
				return null;
			}
			if (opts.validate) {
				const result = await opts.validate(trimmed);
				if (!result.ok) {
					logger(result.reason);
					return null;
				}
			}
			return { apiKey: trimmed, source: "prompt" };
		},
	};
}

/* ─────────────────────────── CLI-token auth method ─────────────────────────── */

/**
 * Build a `ProviderAuthMethod` that resolves credentials by invoking a CLI
 * subprocess (e.g. `gcloud auth print-access-token`, `aws sso login`, the
 * Anthropic CLI's token-print command). Useful for providers whose canonical
 * auth flow is an external SSO-backed binary rather than a long-lived key.
 *
 * `runNonInteractive` runs `command` with `args` and returns the trimmed
 * stdout as the token; non-zero exits or empty stdout resolve to `null` so
 * the caller falls through to an alternative auth method.
 *
 * `run` is identical today — there's no interactive prompt distinct from the
 * subprocess invocation. A future revision may add a "press Enter to attempt
 * CLI auth" confirmation; today the method simply runs the command.
 */
export function createCliTokenAuthMethod(opts: {
	id?: string;
	label?: string;
	/** Executable to invoke (resolved against PATH). */
	command: string;
	/** Arguments passed to the executable. */
	args?: ReadonlyArray<string>;
	/** Max time the subprocess is allowed before being killed. Defaults 8000ms. */
	timeoutMs?: number;
}): ProviderAuthMethod {
	const id = opts.id ?? "cli-token";
	const label = opts.label ?? "CLI token";
	const timeoutMs = opts.timeoutMs ?? 8000;

	const resolveViaCli = async (): Promise<Record<string, unknown> | null> => {
		const { spawn } = await import("node:child_process");
		return new Promise((resolve) => {
			let resolved = false;
			const child = spawn(opts.command, [...(opts.args ?? [])], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			const chunks: Buffer[] = [];
			child.stdout?.on("data", (b: Buffer) => chunks.push(b));
			child.stderr?.on("data", () => {
				/* swallow — the subprocess's own stderr is not surfaced */
			});
			const timer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				try {
					child.kill("SIGTERM");
				} catch {
					/* best-effort */
				}
				resolve(null);
			}, timeoutMs);
			child.on("error", () => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				resolve(null);
			});
			child.on("close", (code) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				if (code !== 0) {
					resolve(null);
					return;
				}
				const token = Buffer.concat(chunks).toString("utf8").trim();
				if (token.length === 0) {
					resolve(null);
					return;
				}
				resolve({ apiKey: token, source: "cli", command: opts.command });
			});
		});
	};

	return {
		id,
		label,
		kind: "cli_token",
		runNonInteractive: async () => resolveViaCli(),
		run: async ({ logger }) => {
			const result = await resolveViaCli();
			if (!result) {
				logger(`${label}: \`${opts.command}\` did not produce a usable token.`);
				return null;
			}
			return result;
		},
	};
}

/* ─────────────────────────── internals ─────────────────────────── */

/**
 * Read a single line from stdin via `node:readline`. Returns the line on
 * success, or `null` if the stream closed before any input arrived. Kept
 * private — provider plugins call the factories above, not this directly.
 */
function readLine(prompt: string): Promise<string | null> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let answered = false;
		rl.question(prompt, (answer) => {
			answered = true;
			rl.close();
			resolve(answer);
		});
		rl.on("close", () => {
			if (!answered) resolve(null);
		});
	});
}
