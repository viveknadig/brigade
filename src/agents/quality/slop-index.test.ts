import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { slopIndex } from "./slop-index.js";

/** Tideline Step 33 — the code Slop-Index. Clean code scores low; duplicated /
 *  deeply-nested / churny code scores high and is flagged. */

describe("slop-index", () => {
	it("clean, flat, unique code scores low with no flags", () => {
		const clean = `export function add(a, b) {\n\treturn a + b;\n}\n\nexport function mul(a, b) {\n\treturn a * b;\n}\n`;
		const r = slopIndex([{ path: "a.ts", content: clean }]);
		assert.ok(r.score < 0.3, `clean code low score (got ${r.score})`);
		assert.deepEqual(r.flags, []);
	});

	it("heavy duplication + deep nesting + churn scores high and flags", () => {
		const dupLine = "const result = computeTheExpensiveThing(inputValue, configObject);";
		const body = Array.from({ length: 12 }, () => dupLine).join("\n");
		const nested = "function f(){ if(a){ if(b){ if(c){ if(d){ if(e){ if(g){ return 1; }}}}}} }";
		const r = slopIndex([{ path: "x.ts", content: `${body}\n${nested}` }], { churn: 4 });
		assert.ok(r.score > 0.4, `sloppy code high score (got ${r.score})`);
		assert.ok(r.flags.some((f) => /duplication/.test(f)), "flags duplication");
		assert.ok(r.flags.some((f) => /nesting/.test(f)), "flags deep nesting");
		assert.ok(r.flags.some((f) => /churn/.test(f)), "flags churn");
		assert.equal(r.signals.churn, 4);
	});
});
