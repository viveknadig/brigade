/**
 * Tests for the browser tool's schema + identity. The Playwright-driven
 * runtime is not exercised here (requires Chromium); the surface contract
 * is checked instead.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BrowserSchema, makeBrowserTool } from "./browser.js";

describe("makeBrowserTool — identity + schema", () => {
	const tool = makeBrowserTool();

	it("registers as `browser`", () => {
		assert.equal(tool.name, "browser");
	});

	it("description mentions system-browser auto-detection", () => {
		// `playwright-core` is a Brigade hard dep, so no install step in
		// the description any more. Operator just needs a system Chrome /
		// Chromium / Edge / Brave.
		assert.match(tool.description, /Chrome|Chromium|Edge|Brave/);
		assert.match(tool.description, /[Aa]uto-detects/);
	});

	it("schema requires `action` and exposes the full action surface", () => {
		const props = (BrowserSchema as unknown as { properties: Record<string, unknown> }).properties;
		assert.ok(props.action, "action is required");
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(required.includes("action"));
		const actionUnion = (props.action as { anyOf?: Array<{ const: string }> }).anyOf ?? [];
		const values = actionUnion.map((a) => a.const).filter(Boolean);
		// Exhaustive: every documented action must be in the schema.
		// If a new action ships without an entry here, the test fails so
		// we don't silently drop coverage.
		const expectedActions = [
			// Lifecycle / introspection
			"status",
			"start",
			"stop",
			"profiles",
			"attach",
			"tabs",
			// Tab navigation
			"open",
			"focus",
			"close",
			"navigate",
			// Capture
			"snapshot",
			"screenshot",
			"pdf",
			// Interaction
			"click",
			"type",
			"press",
			"hover",
			"drag",
			"select",
			"fill",
			"resize",
			"scrollIntoView",
			"evaluate",
			"wait",
			// Capture/handle event streams
			"console",
			"dialog",
			"upload",
		];
		for (const expected of expectedActions) {
			assert.ok(values.includes(expected), `missing action: ${expected}`);
		}
		// Inverse guard: schema doesn't sneak in actions we don't intend.
		assert.equal(
			values.length,
			expectedActions.length,
			`unexpected action count: schema has ${values.length}, expected ${expectedActions.length}. Got: ${values.join(",")}`,
		);
	});

	it("schema exposes new params (profile / disposition / values / files / fields / loadState / endpoint / snapshotFormat)", () => {
		const props = (BrowserSchema as unknown as { properties: Record<string, unknown> }).properties;
		for (const param of [
			"profile",
			"disposition",
			"values",
			"files",
			"fields",
			"loadState",
			"endpoint",
			"snapshotFormat",
			"textGone",
			"timeMs",
			"targetSelector",
			"width",
			"height",
			"maxChars",
			"compact",
		]) {
			assert.ok(props[param], `missing param: ${param}`);
		}
	});

	it("schema makes targetId / url / selector / text / script / profile optional", () => {
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(!required.includes("targetId"));
		assert.ok(!required.includes("url"));
		assert.ok(!required.includes("selector"));
		assert.ok(!required.includes("text"));
		assert.ok(!required.includes("script"));
		assert.ok(!required.includes("profile"));
	});
});

describe("makeBrowserTool — system-browser discovery + error surface", () => {
	it("tool description points at host-installed browsers, not npm install", () => {
		const desc = makeBrowserTool().description;
		// `playwright-core` is a hard dep — operator doesn't run npm install.
		assert.doesNotMatch(desc, /npm install playwright/);
		assert.doesNotMatch(desc, /npx playwright install/);
	});
});
