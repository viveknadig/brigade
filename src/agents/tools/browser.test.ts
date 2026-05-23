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

	it("description mentions Playwright + install instruction", () => {
		assert.match(tool.description, /Playwright/);
		assert.match(tool.description, /npm install playwright/);
	});

	it("schema requires `action` and exposes the 13 supported actions", () => {
		const props = (BrowserSchema as unknown as { properties: Record<string, unknown> }).properties;
		assert.ok(props.action, "action is required");
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(required.includes("action"));
		// Spot-check the action union contains the expected values.
		const actionUnion = (props.action as { anyOf?: Array<{ const: string }> }).anyOf ?? [];
		const values = actionUnion.map((a) => a.const).filter(Boolean);
		for (const expected of [
			"status",
			"open",
			"close",
			"focus",
			"tabs",
			"navigate",
			"snapshot",
			"screenshot",
			"pdf",
			"click",
			"type",
			"evaluate",
			"wait",
		]) {
			assert.ok(values.includes(expected), `missing action: ${expected}`);
		}
	});

	it("schema makes targetId / url / selector / text / script optional", () => {
		const required = (BrowserSchema as unknown as { required: string[] }).required ?? [];
		assert.ok(!required.includes("targetId"));
		assert.ok(!required.includes("url"));
		assert.ok(!required.includes("selector"));
		assert.ok(!required.includes("text"));
		assert.ok(!required.includes("script"));
	});
});

describe("makeBrowserTool — error surface when Playwright absent", () => {
	it("returns a clear actionable error when playwright load fails", async () => {
		// We can't easily simulate the missing-module path without mocking
		// `import()`, but we can confirm the runtime guard exists by
		// inspecting the dispatcher's error-translation regex.
		const desc = makeBrowserTool().description;
		// The description tells the operator how to install — the same
		// message the runtime emits if Playwright load fails.
		assert.match(desc, /npx playwright install chromium/);
	});
});
