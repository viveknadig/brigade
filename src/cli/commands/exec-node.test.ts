/**
 * `brigade exec-node` — the enabler that lets skill-authored scripts `require()`
 * Brigade's bundled document libraries. These tests pin the resolution logic +
 * the usage guard without spawning a child process (the end-to-end run is
 * exercised live by the document skills).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resolveBundledNodeModules, runExecNodeCommand } from "./exec-node.js";

test("resolveBundledNodeModules finds the node_modules holding Brigade's bundled libs", () => {
	const nm = resolveBundledNodeModules();
	assert.ok(nm, "should resolve a path");
	assert.equal(path.basename(nm!), "node_modules", `expected a …/node_modules dir, got ${nm}`);
	assert.ok(existsSync(nm!), "resolved node_modules should exist on disk");
	// At least one known bundled document dep lives under it.
	assert.ok(
		existsSync(path.join(nm!, "fflate")) || existsSync(path.join(nm!, "exceljs")),
		"bundled document deps should be present under the resolved node_modules",
	);
});

test("runExecNodeCommand with no script returns the usage exit code (2)", async () => {
	const code = await runExecNodeCommand([]);
	assert.equal(code, 2);
});
