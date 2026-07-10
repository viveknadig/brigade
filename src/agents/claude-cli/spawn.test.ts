import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS,
	CLAUDE_CLI_OVERALL_TIMEOUT_MS,
	CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS,
	CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS,
} from "./spawn.js";

// The exec-gate awaits an operator approval for up to 5 minutes. A tool-plane
// spawn goes SILENT for that whole wait (it is blocked on Brigade's /mcp
// response), so the no-output watchdog must outlast it — otherwise Brigade
// SIGKILLs its own child before the operator can approve.
const EXEC_GATE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

test("tool-plane no-output watchdog outlasts the exec-gate approval window", () => {
	assert.ok(
		CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS > EXEC_GATE_APPROVAL_TIMEOUT_MS,
		`watchdog ${CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS}ms must exceed approval ${EXEC_GATE_APPROVAL_TIMEOUT_MS}ms`,
	);
	// ...and the plain chat watchdog must NOT be widened (a silent chat turn is wedged).
	assert.ok(CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS < EXEC_GATE_APPROVAL_TIMEOUT_MS);
});

test("tool-plane hard ceiling exceeds the no-output grace and the chat ceiling", () => {
	assert.ok(CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS > CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS);
	assert.ok(CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS > CLAUDE_CLI_OVERALL_TIMEOUT_MS);
});
