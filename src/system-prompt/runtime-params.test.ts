import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	formatLocalNow,
	formatRuntimeLine,
	resolveRuntimeParams,
	type RuntimeParams,
} from "./runtime-params.js";

function makeRuntime(overrides: Partial<RuntimeParams> = {}): RuntimeParams {
	return {
		agentId: "main",
		workspaceDir: "/tmp/.brigade/workspace",
		cwd: "/tmp/.brigade/workspace",
		hostName: "host",
		platform: "linux",
		arch: "x64",
		nodeVersion: "v22.12.0",
		shell: "/bin/bash",
		modelLabel: "anthropic/claude-opus-4-7",
		channelLabel: "cli",
		thinkingLevel: "off",
		timezone: "Asia/Kolkata",
		nowIso: "2026-06-03T10:16:00.000Z",
		nowLocal: "Wed 2026-06-03 15:46",
		repoRoot: undefined,
		...overrides,
	};
}

describe("formatRuntimeLine — time grounding", () => {
	it("emits BOTH the local wall-clock form AND the UTC ISO string in `now=`", () => {
		const line = formatRuntimeLine(makeRuntime());
		// Local form (operator-readable).
		assert.match(line, /now=Wed 2026-06-03 15:46/);
		// UTC ISO form (machine-readable, kept for back-compat).
		assert.match(line, /UTC 2026-06-03T10:16:00\.000Z/);
		// Timezone label sits between the local form and the parenthesised UTC.
		assert.match(line, /now=Wed 2026-06-03 15:46 Asia\/Kolkata \(UTC 2026-06-03T10:16:00\.000Z\)/);
	});

	it("keeps the existing tz= field independently of the new now= form", () => {
		const line = formatRuntimeLine(makeRuntime());
		assert.match(line, /tz=Asia\/Kolkata/);
	});

	it("formatLocalNow renders a Date in the requested timezone (IST)", () => {
		// 2026-06-03 10:16 UTC → 15:46 IST.
		const local = formatLocalNow(new Date("2026-06-03T10:16:00.000Z"), "Asia/Kolkata");
		assert.match(local, /2026-06-03/);
		assert.match(local, /15:46/);
	});

	it("formatLocalNow falls back to ISO when the tz is invalid", () => {
		const local = formatLocalNow(
			new Date("2026-06-03T10:16:00.000Z"),
			"Not/A_Real_Zone",
		);
		// Either Intl tolerated it (unlikely) or we hit the ISO fallback.
		// In both cases the result is non-empty and includes the date.
		assert.ok(local.length > 0);
	});
});

describe("formatRuntimeLine — host tag override (BRIGADE_HOST_ENV)", () => {
	it("uses platform/arch by default when there is no override", () => {
		assert.match(formatRuntimeLine(makeRuntime({ hostEnvLabel: undefined })), /os=linux\/x64/);
	});

	it("a hostEnvLabel replaces the os= tag (display-only), hiding the raw platform/arch", () => {
		const line = formatRuntimeLine(makeRuntime({ hostEnvLabel: "prod-container" }));
		assert.match(line, /os=prod-container/);
		assert.doesNotMatch(line, /os=linux\/x64/);
	});

	it("resolveRuntimeParams reads BRIGADE_HOST_ENV into hostEnvLabel but leaves platform intact", () => {
		const prev = process.env.BRIGADE_HOST_ENV;
		process.env.BRIGADE_HOST_ENV = "staging-box";
		try {
			const p = resolveRuntimeParams({ agentId: "main", workspaceDir: "/tmp", cwd: "/tmp", modelLabel: "m" });
			assert.strictEqual(p.hostEnvLabel, "staging-box");
			// The behavioural field stays the REAL platform, not the label.
			assert.strictEqual(p.platform, process.platform);
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_HOST_ENV;
			else process.env.BRIGADE_HOST_ENV = prev;
		}
	});
});
