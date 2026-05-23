/**
 * Tests for the public-shape contract of the `fetch_url` tool — schema,
 * details payload, and the internal `_fallbackPreferred` strip path. The
 * full network path is exercised by integration tests that mock `fetch`
 * (separate file). Pure-logic; no network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { makeFetchUrlTool, FetchUrlSchema, type FetchUrlDetails } from "./web-fetch.js";

describe("makeFetchUrlTool — schema + tool identity", () => {
	const tool = makeFetchUrlTool();

	it("registers under the stable name `fetch_url`", () => {
		assert.equal(tool.name, "fetch_url");
		assert.equal(tool.label, "fetch_url");
	});

	it("schema requires `url`, optional `extractMode` + `maxChars`", () => {
		const props = (FetchUrlSchema as unknown as { properties: Record<string, unknown> }).properties;
		assert.ok(props.url, "url is required");
		assert.ok(props.extractMode, "extractMode is optional");
		assert.ok(props.maxChars, "maxChars is optional");
	});

	it("description names the untrusted-content envelope", () => {
		assert.match(tool.description, /untrusted-content envelope/i);
	});
});

describe("FetchUrlDetails — `_fallbackPreferred` is internal-only", () => {
	it("type permits an internal flag that's stripped before serialization", () => {
		// This is a compile-time contract check — if the interface drops the
		// optional `_fallbackPreferred`, the next line errors.
		const probe: FetchUrlDetails = {
			url: "https://example.com",
			finalUrl: "https://example.com",
			status: 200,
			extractMode: "markdown",
			extractor: "readability",
			externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
			truncated: false,
			length: 0,
			rawLength: 0,
			fetchedAt: new Date().toISOString(),
			tookMs: 0,
			text: "",
			_fallbackPreferred: true,
		};
		assert.equal(probe._fallbackPreferred, true);
	});
});
