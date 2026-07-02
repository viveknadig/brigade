import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseJsonObjectPreservingUnsafeIntegers,
	parseJsonPreservingUnsafeIntegers,
} from "./ollama-json.js";

describe("parseJsonPreservingUnsafeIntegers", () => {
	it("parses normal JSON like JSON.parse", () => {
		assert.deepEqual(parseJsonPreservingUnsafeIntegers('{"a":1,"b":"x","c":[1,2,3]}'), {
			a: 1,
			b: "x",
			c: [1, 2, 3],
		});
	});

	it("preserves integers beyond MAX_SAFE_INTEGER as exact strings", () => {
		// 9007199254740993 = MAX_SAFE_INTEGER + 2 (would round to ...992 as a double)
		const out = parseJsonPreservingUnsafeIntegers('{"total_duration":9007199254740993}') as {
			total_duration: unknown;
		};
		assert.equal(out.total_duration, "9007199254740993");
	});

	it("leaves safe integers, floats, and exponentials as numbers", () => {
		const out = parseJsonPreservingUnsafeIntegers('{"a":42,"b":3.14,"c":1e3,"d":-7}') as Record<string, unknown>;
		assert.equal(out.a, 42);
		assert.equal(out.b, 3.14);
		assert.equal(out.c, 1000);
		assert.equal(out.d, -7);
	});

	it("does not touch digits inside string values", () => {
		const out = parseJsonPreservingUnsafeIntegers('{"s":"id 9007199254740993 here"}') as { s: string };
		assert.equal(out.s, "id 9007199254740993 here");
	});
});

describe("parseJsonObjectPreservingUnsafeIntegers", () => {
	it("parses a JSON string into an object", () => {
		assert.deepEqual(parseJsonObjectPreservingUnsafeIntegers('{"query":"x","count":5}'), {
			query: "x",
			count: 5,
		});
	});
	it("passes a plain object through unchanged", () => {
		const o = { a: 1 };
		assert.equal(parseJsonObjectPreservingUnsafeIntegers(o), o);
	});
	it("returns null for arrays, non-objects, and unparseable strings", () => {
		assert.equal(parseJsonObjectPreservingUnsafeIntegers("[1,2]"), null);
		assert.equal(parseJsonObjectPreservingUnsafeIntegers("not json"), null);
		assert.equal(parseJsonObjectPreservingUnsafeIntegers(42), null);
		assert.equal(parseJsonObjectPreservingUnsafeIntegers(null), null);
	});
});
