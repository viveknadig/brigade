// The stream idle-timeout measures silence on the wire. Which providers that is a
// sound liveness signal for — and which it actively breaks — is a decision worth
// pinning, because getting it wrong is invisible: the attempt dies, Pi auto-retries,
// the model starts the task over, and the operator sees only a stalled screen.

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveIdleTimeoutMs } from "./agent-loop.js";

const ENV_KEY = "BRIGADE_LLM_IDLE_TIMEOUT_SECONDS";

function withoutEnv<T>(fn: () => T): T {
	const prev = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	try {
		return fn();
	} finally {
		if (prev !== undefined) process.env[ENV_KEY] = prev;
	}
}

test("a cloud provider keeps the 90s idle window", () => {
	withoutEnv(() => {
		assert.equal(resolveIdleTimeoutMs("anthropic"), 90_000);
		assert.equal(resolveIdleTimeoutMs("openai"), 90_000);
		assert.equal(resolveIdleTimeoutMs(undefined), 90_000);
	});
});

test("local ollama gets a longer window — a cold start is not a hung stream", () => {
	withoutEnv(() => {
		assert.equal(resolveIdleTimeoutMs("ollama"), 300_000);
	});
});

test("a HARNESS backend disables the idle window entirely", () => {
	// The `claude` binary runs its own tool loop: it writes nothing to stdout while
	// it thinks, and nothing at all while it blocks on one of OUR tool calls — a
	// `bash` awaiting the operator's approval (up to 5 min), an `analyze_media`
	// chewing a PDF, a `spawn_agent` running a whole sub-agent turn.
	//
	// We pause the CHILD's watchdogs for exactly that window. This timer sits on the
	// parent's side of the pipe and cannot be paused, so at 90s it killed a perfectly
	// healthy turn, Pi auto-retried, and the binary restarted the task from the top.
	//
	// Liveness is not lost: the child's own no-output watchdog (360s, tool-aware),
	// its sliding hard ceiling, and its unpausable absolute ceiling all still apply.
	withoutEnv(() => {
		assert.equal(resolveIdleTimeoutMs("claude-cli"), 0, "0 => wrapStreamFnWithIdleTimeout returns the base fn");
	});
});

test("an explicit operator override still wins for every provider", () => {
	const prev = process.env[ENV_KEY];
	process.env[ENV_KEY] = "45";
	try {
		assert.equal(resolveIdleTimeoutMs("anthropic"), 45_000);
		assert.equal(resolveIdleTimeoutMs("ollama"), 45_000);
		// Including the harness: an operator who asks for a window gets one.
		assert.equal(resolveIdleTimeoutMs("claude-cli"), 45_000);
	} finally {
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	}
});

test("`0` disables the window, as documented", () => {
	const prev = process.env[ENV_KEY];
	process.env[ENV_KEY] = "0";
	try {
		assert.equal(resolveIdleTimeoutMs("anthropic"), 0);
	} finally {
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	}
});
