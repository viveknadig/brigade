import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BrigadeExtensionRegistry } from "../agents/extensions/registry.js";
import type { BrigadeConfig } from "../config/io.js";
import { createApiKeyAuthMethod, createCliTokenAuthMethod } from "./auth-methods.js";

const META = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd", config: {} as BrigadeConfig };

describe("createApiKeyAuthMethod", () => {
	it("kind is 'api_key' and id/label default sensibly", () => {
		const m = createApiKeyAuthMethod({ envVar: "FOO_API_KEY" });
		assert.equal(m.kind, "api_key");
		assert.equal(m.id, "api-key");
		assert.equal(m.label, "API key");
	});

	it("runNonInteractive reads the primary env var", async () => {
		const m = createApiKeyAuthMethod({ envVar: "BRIGADE_TEST_PRIMARY" });
		const env = { BRIGADE_TEST_PRIMARY: "sk-primary-123" };
		const result = await m.runNonInteractive!({ env: env as NodeJS.ProcessEnv });
		assert.deepEqual(result, { apiKey: "sk-primary-123", source: "env", envVar: "BRIGADE_TEST_PRIMARY" });
	});

	it("runNonInteractive trims whitespace and ignores empty/whitespace-only env values", async () => {
		const m = createApiKeyAuthMethod({
			envVar: "BRIGADE_TEST_PRIMARY",
			envVarFallbacks: ["BRIGADE_TEST_FALLBACK"],
		});
		// Primary is whitespace-only; fallback wins.
		const env = { BRIGADE_TEST_PRIMARY: "   ", BRIGADE_TEST_FALLBACK: "  sk-fallback-xyz  " };
		const result = await m.runNonInteractive!({ env: env as NodeJS.ProcessEnv });
		assert.deepEqual(result, {
			apiKey: "sk-fallback-xyz",
			source: "env",
			envVar: "BRIGADE_TEST_FALLBACK",
		});
	});

	it("runNonInteractive falls back to envVarFallbacks in order", async () => {
		const m = createApiKeyAuthMethod({
			envVar: "BRIGADE_TEST_PRIMARY",
			envVarFallbacks: ["BRIGADE_TEST_ALT1", "BRIGADE_TEST_ALT2"],
		});
		// Primary unset, first fallback unset, second fallback set.
		const env = { BRIGADE_TEST_ALT2: "sk-alt2-key" };
		const result = await m.runNonInteractive!({ env: env as NodeJS.ProcessEnv });
		assert.deepEqual(result, {
			apiKey: "sk-alt2-key",
			source: "env",
			envVar: "BRIGADE_TEST_ALT2",
		});
	});

	it("runNonInteractive returns null when no env var is set", async () => {
		const m = createApiKeyAuthMethod({
			envVar: "BRIGADE_TEST_PRIMARY",
			envVarFallbacks: ["BRIGADE_TEST_ALT"],
		});
		const result = await m.runNonInteractive!({ env: {} as NodeJS.ProcessEnv });
		assert.equal(result, null);
	});

	it("custom id and label override defaults", () => {
		const m = createApiKeyAuthMethod({
			id: "anthropic-admin-key",
			label: "Anthropic admin key",
			envVar: "ANTHROPIC_ADMIN_KEY",
		});
		assert.equal(m.id, "anthropic-admin-key");
		assert.equal(m.label, "Anthropic admin key");
	});
});

describe("createCliTokenAuthMethod", () => {
	it("kind is 'cli_token' and id/label default sensibly", () => {
		const m = createCliTokenAuthMethod({ command: "echo", args: ["token-abc"] });
		assert.equal(m.kind, "cli_token");
		assert.equal(m.id, "cli-token");
		assert.equal(m.label, "CLI token");
	});

	it("runNonInteractive returns the trimmed stdout of the command on success", async () => {
		// `node -e` is universally available since this codebase requires Node ≥22.
		const m = createCliTokenAuthMethod({
			command: process.execPath,
			args: ["-e", "process.stdout.write('  cli-token-value  \\n')"],
		});
		const result = await m.runNonInteractive!({ env: {} as NodeJS.ProcessEnv });
		assert.ok(result, "expected a credential record");
		assert.equal((result as { apiKey: string }).apiKey, "cli-token-value");
		assert.equal((result as { source: string }).source, "cli");
	});

	it("runNonInteractive returns null when the command exits non-zero", async () => {
		const m = createCliTokenAuthMethod({
			command: process.execPath,
			args: ["-e", "process.exit(1)"],
		});
		const result = await m.runNonInteractive!({ env: {} as NodeJS.ProcessEnv });
		assert.equal(result, null);
	});

	it("runNonInteractive returns null when stdout is empty", async () => {
		const m = createCliTokenAuthMethod({
			command: process.execPath,
			args: ["-e", "process.stdout.write('')"],
		});
		const result = await m.runNonInteractive!({ env: {} as NodeJS.ProcessEnv });
		assert.equal(result, null);
	});
});

describe("BrigadeExtensionContext.providerAuthMethod registration", () => {
	it("records auth methods + exposes them via providerAuthMethods()", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		const apiKey = createApiKeyAuthMethod({ envVar: "ANTHROPIC_API_KEY" });
		const cli = createCliTokenAuthMethod({ command: "claude", args: ["auth", "print-token"] });

		b.providerAuthMethod("anthropic", apiKey);
		b.providerAuthMethod("anthropic", cli);
		b.providerAuthMethod("openai", createApiKeyAuthMethod({ envVar: "OPENAI_API_KEY" }));

		assert.equal(reg.providerAuthMethods().length, 3);
		const anthropic = reg.providerAuthMethods("anthropic");
		assert.equal(anthropic.length, 2);
		// Registration order preserved → first viable wins at resolution time.
		assert.equal(anthropic[0]?.method.id, "api-key");
		assert.equal(anthropic[1]?.method.id, "cli-token");
		assert.equal(reg.providerAuthMethods("openai").length, 1);
		assert.equal(reg.providerAuthMethods("nonexistent").length, 0);
	});
});
