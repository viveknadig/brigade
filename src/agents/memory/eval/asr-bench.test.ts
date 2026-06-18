import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { BASELINE_ASR, runDefaultAsrBench } from "./asr-bench.js";

/**
 * Tideline Step 26 — the ASR bench. Brigade's write-gate must drive the
 * Attack-Success-Rate to ~0 (block every poisoning write) while passing the
 * legitimate ones, beating the published competitor numbers.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-asr-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("asr-bench", () => {
	it("the write-gate blocks every poisoning write (ASR 0) and passes legit ones", () => {
		const r = runDefaultAsrBench(dir);
		assert.ok(r.attempts >= 9, "the corpus has the poisoning attempts");
		assert.equal(r.succeeded, 0, "no poisoning write got through");
		assert.equal(r.asr, 0, "ASR is 0");
		assert.equal(r.falsePositives, 0, "no legitimate write was wrongly blocked");
	});

	it("beats the published baseline ASRs", () => {
		const r = runDefaultAsrBench(dir);
		assert.ok(r.beatsBaselineA, `ASR ${r.asr} < baseline A ${BASELINE_ASR.baselineA}`);
		assert.ok(r.beatsBaselineB, `ASR ${r.asr} < baseline B ${BASELINE_ASR.baselineB}`);
	});
});
