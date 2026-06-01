import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	clearBinaryCache,
	extractFrontmatterBlock,
	hasBinary,
	isSkillEligible,
	parseEligibility,
	type SkillEligibility,
} from "./eligibility.js";

afterEach(() => clearBinaryCache());

describe("extractFrontmatterBlock", () => {
	it("extracts the leading --- fenced block", () => {
		const fm = extractFrontmatterBlock("---\nname: x\ndescription: y\n---\n# Body\n");
		assert.equal(fm, "name: x\ndescription: y");
	});
	it("tolerates CRLF and a leading BOM", () => {
		const fm = extractFrontmatterBlock("﻿---\r\nos: linux\r\n---\r\nbody");
		assert.equal(fm, "os: linux");
	});
	it("returns '' when there's no leading block", () => {
		assert.equal(extractFrontmatterBlock("# No frontmatter\nbody"), "");
		assert.equal(extractFrontmatterBlock("text\n---\nnot at top\n---"), "");
		assert.equal(extractFrontmatterBlock("---\nunterminated\nbody"), "");
	});
});

describe("parseEligibility", () => {
	it("parses os + requires-* as CSV, mapping friendly OS names", () => {
		const meta = parseEligibility(
			"name: gh\nos: macos, linux, windows\nrequires-bins: gh\nrequires-any-bins: rg, grep\nrequires-env: TOKEN, OTHER",
		);
		assert.deepEqual(meta.os, ["darwin", "linux", "win32"]);
		assert.deepEqual(meta.requiresBins, ["gh"]);
		assert.deepEqual(meta.requiresAnyBins, ["rg", "grep"]);
		assert.deepEqual(meta.requiresEnv, ["TOKEN", "OTHER"]);
	});
	it("ignores unrelated keys, comments, and blank lines", () => {
		const meta = parseEligibility("# c\nname: x\n\ndescription: y\nrandom: 1");
		assert.deepEqual(meta, {
			os: [],
			requiresBins: [],
			requiresAnyBins: [],
			requiresEnv: [],
			requiresConfig: [],
		});
	});
	it("treats a truly empty key (no inline value, no block items) as absent", () => {
		const meta = parseEligibility("os:\nname: x\nrequires-bins:\ndescription: y");
		assert.deepEqual(meta.os, []);
		assert.deepEqual(meta.requiresBins, []);
	});

	it("parses YAML block-sequence form (what a formatter leaves behind)", () => {
		const meta = parseEligibility(
			"name: gh\nos:\n  - darwin\n  - linux\nrequires-bins:\n  - gh\n  - jq\ndescription: y",
		);
		assert.deepEqual(meta.os, ["darwin", "linux"]);
		assert.deepEqual(meta.requiresBins, ["gh", "jq"]);
	});

	it("block-sequence stops at the next key (doesn't bleed across keys)", () => {
		const meta = parseEligibility("requires-bins:\n  - gh\nrequires-env:\n  - TOKEN");
		assert.deepEqual(meta.requiresBins, ["gh"]);
		assert.deepEqual(meta.requiresEnv, ["TOKEN"]);
		assert.deepEqual(meta.os, []);
	});

	it("inline flow-sequence form `[a, b]` still parses", () => {
		const meta = parseEligibility('os: [macos, "linux"]');
		assert.deepEqual(meta.os, ["darwin", "linux"]);
	});

	it("reads the nested metadata.brigade block (ported form, incl. trailing commas)", () => {
		const fm = [
			"name: sherpa",
			"metadata:",
			'  { "brigade": { "os": ["darwin","linux","win32"],',
			'      "requires": { "env": ["RUNTIME_DIR","MODEL_DIR"], },',
			'      "install": [ {"id":"a"}, {"id":"b"}, ], }, }',
		].join("\n");
		const meta = parseEligibility(fm);
		assert.deepEqual(meta.os, ["darwin", "linux", "win32"]);
		assert.deepEqual(meta.requiresEnv, ["RUNTIME_DIR", "MODEL_DIR"]);
	});

	it("metadata.brigade.requires.bins / anyBins parse", () => {
		const fm = 'metadata:\n  { "brigade": { "requires": { "bins": ["gh"], "anyBins": ["rg","grep"] } } }';
		const meta = parseEligibility(fm);
		assert.deepEqual(meta.requiresBins, ["gh"]);
		assert.deepEqual(meta.requiresAnyBins, ["rg", "grep"]);
	});

	it("flat keys fill in fields the metadata block doesn't set", () => {
		// metadata.brigade sets only os; flat requires-bins supplies the rest.
		const fm = 'metadata:\n  { "brigade": { "os": ["linux"] } }\nrequires-bins: jq';
		const meta = parseEligibility(fm);
		assert.deepEqual(meta.os, ["linux"]);
		assert.deepEqual(meta.requiresBins, ["jq"]);
	});

	it("malformed frontmatter → no constraints (eligible), never throws", () => {
		const meta = parseEligibility("os: [unterminated\n  : : :");
		assert.deepEqual(meta, {
			os: [],
			requiresBins: [],
			requiresAnyBins: [],
			requiresEnv: [],
			requiresConfig: [],
		});
	});
});

const NONE: SkillEligibility = {
	os: [],
	requiresBins: [],
	requiresAnyBins: [],
	requiresEnv: [],
	requiresConfig: [],
};

describe("isSkillEligible", () => {
	const env = { PATH: "" } as NodeJS.ProcessEnv;

	it("is eligible when no constraints are declared", () => {
		assert.equal(isSkillEligible(NONE, { platform: "linux", env }), true);
	});

	it("filters by OS", () => {
		const meta = { ...NONE, os: ["darwin"] };
		assert.equal(isSkillEligible(meta, { platform: "darwin", env }), true);
		assert.equal(isSkillEligible(meta, { platform: "win32", env }), false);
	});

	it("requires ALL bins (missing one fails)", () => {
		const meta = { ...NONE, requiresBins: ["definitely-not-a-real-bin-xyz"] };
		assert.equal(isSkillEligible(meta, { platform: "linux", env }), false);
	});

	it("requires-env: ALL env vars must be set & non-empty", () => {
		const meta = { ...NONE, requiresEnv: ["MY_TOKEN"] };
		assert.equal(isSkillEligible(meta, { platform: "linux", env: { MY_TOKEN: "abc", PATH: "" } }), true);
		assert.equal(isSkillEligible(meta, { platform: "linux", env: { MY_TOKEN: "  ", PATH: "" } }), false);
		assert.equal(isSkillEligible(meta, { platform: "linux", env: { PATH: "" } }), false);
	});

	it("requires-any-bins fails only when NONE are present", () => {
		const meta = { ...NONE, requiresAnyBins: ["nope-a-xyz", "nope-b-xyz"] };
		assert.equal(isSkillEligible(meta, { platform: "linux", env }), false);
	});

	it("requires-any-bins passes when at least one binary is on PATH", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-bin-"));
		try {
			// A probe binary present on PATH (with a Windows-executable variant).
			fs.writeFileSync(path.join(dir, "mybin"), "", "utf8");
			fs.writeFileSync(path.join(dir, "mybin.exe"), "", "utf8");
			fs.writeFileSync(path.join(dir, "mybin.cmd"), "", "utf8");
			const withBin = { PATH: dir, Path: dir } as NodeJS.ProcessEnv;
			assert.equal(hasBinary("mybin", withBin), true);
			const meta = { ...NONE, requiresAnyBins: ["mybin", "nope-xyz"] };
			assert.equal(isSkillEligible(meta, { platform: process.platform, env: withBin }), true);
			// requires-bins (ALL) passes too when the one bin is present.
			assert.equal(
				isSkillEligible({ ...NONE, requiresBins: ["mybin"] }, { platform: process.platform, env: withBin }),
				true,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
