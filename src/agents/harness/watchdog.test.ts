import assert from "node:assert/strict";
import { test } from "node:test";

import {
	__clearHarnessWatchdogs,
	pauseHarnessWatchdog,
	registerHarnessWatchdog,
	unregisterHarnessWatchdog,
} from "./watchdog.js";

const TOKEN = "a".repeat(64);

function fakeWatchdog() {
	const state = { paused: 0, resumed: 0 };
	return {
		state,
		wd: {
			pause: () => {
				state.paused += 1;
				return () => {
					state.resumed += 1;
				};
			},
		},
	};
}

test("pause/resume reaches the registered child", () => {
	__clearHarnessWatchdogs();
	const { state, wd } = fakeWatchdog();
	registerHarnessWatchdog(TOKEN, wd);

	const resume = pauseHarnessWatchdog(TOKEN);
	assert.equal(state.paused, 1);
	resume();
	assert.equal(state.resumed, 1);
	__clearHarnessWatchdogs();
});

test("an unknown token is a harmless no-op — the caller never has to branch", () => {
	__clearHarnessWatchdogs();
	// memory-only stdio plane (no token), a cold path, or a child that already exited
	assert.doesNotThrow(() => pauseHarnessWatchdog("nope")());
	assert.doesNotThrow(() => pauseHarnessWatchdog("")());
});

test("unregister stops further pauses reaching a dead child", () => {
	__clearHarnessWatchdogs();
	const { state, wd } = fakeWatchdog();
	registerHarnessWatchdog(TOKEN, wd);
	unregisterHarnessWatchdog(TOKEN);
	pauseHarnessWatchdog(TOKEN)();
	assert.equal(state.paused, 0, "the child is gone; nothing to pause");
});

test("a throwing child pause never breaks the tool call", () => {
	__clearHarnessWatchdogs();
	registerHarnessWatchdog(TOKEN, {
		pause: () => {
			throw new Error("child already exited");
		},
	});
	let resume: (() => void) | undefined;
	assert.doesNotThrow(() => {
		resume = pauseHarnessWatchdog(TOKEN);
	});
	assert.doesNotThrow(() => resume?.());
	__clearHarnessWatchdogs();
});

test("registry is keyed per turn — one child's pause never touches another's", () => {
	__clearHarnessWatchdogs();
	const a = fakeWatchdog();
	const b = fakeWatchdog();
	registerHarnessWatchdog("a".repeat(64), a.wd);
	registerHarnessWatchdog("b".repeat(64), b.wd);

	pauseHarnessWatchdog("a".repeat(64))();
	assert.equal(a.state.paused, 1);
	assert.equal(b.state.paused, 0, "concurrent turns are isolated");
	__clearHarnessWatchdogs();
});
