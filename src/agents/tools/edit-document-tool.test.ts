/**
 * Tests for the `edit_document` tool (EDIT docx / xlsx / pptx / pdf).
 *
 * Fixtures are built with `make_document` (real, pure-JS libs), then each edit
 * action runs for real and the result is re-opened to prove the mutation took
 * AND the file still opens:
 *   - docx replace_text changes the run text + the file still unzips.
 *   - docx append adds paragraphs at the end.
 *   - xlsx set_cells updates the cell + the OTHER sheet is intact.
 *   - xlsx append_rows grows the sheet.
 *   - pptx replace_text changes slide text.
 *   - pdf fill_form sets a field; merge combines page counts; split → N files;
 *     watermark/stamp/remove_pages keep the file loadable.
 * Plus: source / output path guard refusals, and malformed input → clean error.
 *
 * The pure helper exports (`parsePageList`, `replaceInRunText`) get focused units.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { unzipSync, strFromU8 } from "fflate";

import { makeMakeDocumentTool, type MakeDocumentDetails } from "./make-document-tool.js";
import {
	makeEditDocumentTool,
	parsePageList,
	replaceInRunText,
	type EditDocumentDetails,
} from "./edit-document-tool.js";
import { BrigadeToolInputError } from "./common.js";
import type { AgentToolResult } from "./types.js";

let workspace: string;

before(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-editdoc-"));
});
beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-editdoc-ws-"));
});
after(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function det<T>(r: AgentToolResult<T>): T {
	const text = r.content.find((b): b is { type: "text"; text: string } => b.type === "text");
	return JSON.parse(text?.text ?? "{}") as T;
}

function mk() {
	return makeMakeDocumentTool({ workspaceDir: workspace, cwd: workspace });
}
function ed() {
	return makeEditDocumentTool({ workspaceDir: workspace, cwd: workspace });
}

async function makeDoc(format: "docx" | "xlsx" | "pptx" | "pdf", content: unknown, name: string): Promise<string> {
	const out = path.join(workspace, name);
	const r = (await mk().execute("mk", { format, outputPath: out, content: content as never })) as AgentToolResult<MakeDocumentDetails>;
	assert.equal(det(r).ok, true, `fixture ${name} built`);
	return out;
}

/* ─────────────────────────── docx ─────────────────────────── */

describe("edit_document — docx", () => {
	it("replace_text changes the run text + the file still unzips", async () => {
		const src = await makeDoc(
			"docx",
			{ sections: [{ paragraphs: ["The quick brown FINDME jumps."] }] },
			"r.docx",
		);
		const r = (await ed().execute("e", {
			source: src,
			action: "replace_text",
			find: "FINDME",
			replace: "REPLACED",
		})) as AgentToolResult<EditDocumentDetails>;
		const d = det(r);
		assert.equal(d.ok, true);
		assert.equal(d.replacements, 1);
		const xml = strFromU8(
			unzipSync(new Uint8Array(fs.readFileSync(src)))["word/document.xml"] as Uint8Array,
		);
		assert.match(xml, /REPLACED/);
		assert.doesNotMatch(xml, /FINDME/);
	});

	it("append adds a heading + paragraphs at the end", async () => {
		const src = await makeDoc("docx", { sections: [{ paragraphs: ["original"] }] }, "a.docx");
		const r = (await ed().execute("e", {
			source: src,
			action: "append",
			heading: "Appendix",
			paragraphs: ["APPENDEDLINE"],
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).ok, true);
		const xml = strFromU8(
			unzipSync(new Uint8Array(fs.readFileSync(src)))["word/document.xml"] as Uint8Array,
		);
		assert.match(xml, /APPENDEDLINE/);
		assert.match(xml, /Appendix/);
		// original text survives.
		assert.match(xml, /original/);
	});

	it("writes to outputPath when given (source left unchanged)", async () => {
		const src = await makeDoc("docx", { sections: [{ paragraphs: ["KEEPME"] }] }, "src.docx");
		const out = path.join(workspace, "copy.docx");
		await ed().execute("e", {
			source: src,
			action: "replace_text",
			find: "KEEPME",
			replace: "CHANGED",
			outputPath: out,
		});
		const srcXml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(src)))["word/document.xml"] as Uint8Array);
		const outXml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(out)))["word/document.xml"] as Uint8Array);
		assert.match(srcXml, /KEEPME/, "source untouched");
		assert.match(outXml, /CHANGED/, "copy edited");
	});

	it("replace_text without find → clean error", async () => {
		const src = await makeDoc("docx", { sections: [{ paragraphs: ["x"] }] }, "e.docx");
		await assert.rejects(
			() => ed().execute("e", { source: src, action: "replace_text" }),
			(err: unknown) => err instanceof BrigadeToolInputError && /find/i.test((err as Error).message),
		);
	});

	it("an unknown docx action → clean error listing valid actions", async () => {
		const src = await makeDoc("docx", { sections: [{ paragraphs: ["x"] }] }, "u.docx");
		await assert.rejects(
			() => ed().execute("e", { source: src, action: "frobnicate" }),
			/unsupported docx action/i,
		);
	});
});

/* ─────────────────────────── xlsx ─────────────────────────── */

describe("edit_document — xlsx", () => {
	it("set_cells updates the cell + other sheets stay intact", async () => {
		const src = await makeDoc(
			"xlsx",
			{ sheets: [{ name: "A", rows: [["x", "y"]] }, { name: "B", rows: [["keep"]] }] },
			"s.xlsx",
		);
		const r = (await ed().execute("e", {
			source: src,
			action: "set_cells",
			sheet: "A",
			cells: [{ ref: "A1", value: "CHANGED" }, { row: 1, col: 2, value: 99 }],
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).cellsSet, 2);
		const ExcelJS = (await import("exceljs")).default;
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(fs.readFileSync(src) as never);
		const a = wb.getWorksheet("A");
		const b = wb.getWorksheet("B");
		assert.equal(a?.getCell("A1").value, "CHANGED");
		assert.equal(a?.getCell(1, 2).value, 99);
		assert.equal(b?.getCell("A1").value, "keep", "other sheet intact");
	});

	it("append_rows grows the sheet", async () => {
		const src = await makeDoc("xlsx", { sheets: [{ name: "A", rows: [["r1"]] }] }, "ar.xlsx");
		const r = (await ed().execute("e", {
			source: src,
			action: "append_rows",
			sheet: "A",
			rows: [["r2a", "r2b"], ["r3"]],
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).rowsAppended, 2);
		const ExcelJS = (await import("exceljs")).default;
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(fs.readFileSync(src) as never);
		assert.ok((wb.getWorksheet("A")?.rowCount ?? 0) >= 3);
	});

	it("set_cells without cells → clean error", async () => {
		const src = await makeDoc("xlsx", { sheets: [{ rows: [["x"]] }] }, "ec.xlsx");
		await assert.rejects(
			() => ed().execute("e", { source: src, action: "set_cells" }),
			/cells/i,
		);
	});
});

/* ─────────────────────────── pptx ─────────────────────────── */

describe("edit_document — pptx", () => {
	it("replace_text changes slide text + the deck still unzips", async () => {
		const src = await makeDoc(
			"pptx",
			{ slides: [{ title: "Hello FINDSLIDE world" }, { title: "Plain" }] },
			"p.pptx",
		);
		const r = (await ed().execute("e", {
			source: src,
			action: "replace_text",
			find: "FINDSLIDE",
			replace: "SWAPPED",
		})) as AgentToolResult<EditDocumentDetails>;
		const d = det(r);
		assert.equal(d.ok, true);
		assert.ok((d.replacements ?? 0) >= 1);
		const entries = unzipSync(new Uint8Array(fs.readFileSync(src)));
		const slide1 = strFromU8(entries["ppt/slides/slide1.xml"] as Uint8Array);
		assert.match(slide1, /SWAPPED/);
		assert.doesNotMatch(slide1, /FINDSLIDE/);
	});
});

/* ─────────────────────────── pdf ─────────────────────────── */

describe("edit_document — pdf", () => {
	/** Build a PDF carrying a fillable text field named `name`. */
	async function makeFormPdf(name: string): Promise<string> {
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		const pdf = await PDFDocument.create();
		const page = pdf.addPage([300, 200]);
		const field = pdf.getForm().createTextField("name");
		field.addToPage(page, { x: 10, y: 10, width: 120, height: 20 });
		const out = path.join(workspace, name);
		fs.writeFileSync(out, await pdf.save());
		return out;
	}

	it("fill_form sets a text field value", async () => {
		const src = await makeFormPdf("form.pdf");
		const r = (await ed().execute("e", {
			source: src,
			action: "fill_form",
			fields: { name: "Alice" },
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).fieldsSet, 1);
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		const pdf = await PDFDocument.load(fs.readFileSync(src));
		assert.equal(pdf.getForm().getTextField("name").getText(), "Alice");
	});

	it("fill_form reports unknown fields as a warning (no throw)", async () => {
		const src = await makeFormPdf("form2.pdf");
		const r = (await ed().execute("e", {
			source: src,
			action: "fill_form",
			fields: { nope: "x" },
		})) as AgentToolResult<EditDocumentDetails>;
		const d = det(r);
		assert.equal(d.ok, true);
		assert.equal(d.fieldsSet, 0);
		assert.match(d.warning ?? "", /not found/i);
	});

	it("merge combines the page counts of source + appended PDFs", async () => {
		const a = await makeDoc("pdf", { pages: [{ paragraphs: ["a1"] }, { paragraphs: ["a2"] }] }, "a.pdf");
		const b = await makeDoc("pdf", { pages: [{ paragraphs: ["b1"] }] }, "b.pdf");
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		const aPages = (await PDFDocument.load(fs.readFileSync(a))).getPageCount();
		const bPages = (await PDFDocument.load(fs.readFileSync(b))).getPageCount();
		const out = path.join(workspace, "merged.pdf");
		const r = (await ed().execute("e", {
			source: a,
			action: "merge",
			pdfs: [b],
			outputPath: out,
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).pages, aPages + bPages);
		assert.equal((await PDFDocument.load(fs.readFileSync(out))).getPageCount(), aPages + bPages);
	});

	it("split produces one output file per range", async () => {
		const src = await makeDoc(
			"pdf",
			{ pages: [{ paragraphs: ["1"] }, { paragraphs: ["2"] }, { paragraphs: ["3"] }, { paragraphs: ["4"] }] },
			"split-src.pdf",
		);
		const r = (await ed().execute("e", {
			source: src,
			action: "split",
			pages: "1,2-3",
		})) as AgentToolResult<EditDocumentDetails>;
		const d = det(r);
		assert.equal(d.ok, true);
		assert.equal(d.paths?.length, 2, "two output files");
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		assert.equal((await PDFDocument.load(fs.readFileSync(d.paths![0] as string))).getPageCount(), 1);
		assert.equal((await PDFDocument.load(fs.readFileSync(d.paths![1] as string))).getPageCount(), 2);
	});

	it("remove_pages deletes the named pages and keeps the file loadable", async () => {
		const src = await makeDoc(
			"pdf",
			{ pages: [{ paragraphs: ["1"] }, { paragraphs: ["2"] }, { paragraphs: ["3"] }] },
			"rm.pdf",
		);
		const r = (await ed().execute("e", {
			source: src,
			action: "remove_pages",
			pages: "2",
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).pages, 2);
	});

	it("watermark stamps every page and keeps the PDF valid", async () => {
		const src = await makeDoc("pdf", { pages: [{ paragraphs: ["x"] }, { paragraphs: ["y"] }] }, "wm.pdf");
		const out = path.join(workspace, "wm-out.pdf");
		const r = (await ed().execute("e", {
			source: src,
			action: "watermark",
			text: "CONFIDENTIAL",
			outputPath: out,
		})) as AgentToolResult<EditDocumentDetails>;
		assert.equal(det(r).ok, true);
		const { PDFDocument } = await import("@cantoo/pdf-lib");
		assert.ok((await PDFDocument.load(fs.readFileSync(out))).getPageCount() >= 2);
	});

	it("fill_form without fields → clean error", async () => {
		const src = await makeFormPdf("form3.pdf");
		await assert.rejects(() => ed().execute("e", { source: src, action: "fill_form" }), /fields/i);
	});
});

/* ─────────────────────────── path guard + format detection ─────────────────────────── */

describe("edit_document — path guard + format detection", () => {
	it("refuses a source outside the allowed roots (valid extension)", async () => {
		const outside =
			process.platform === "win32" ? "C:\\Users\\Public\\outside-brigade.docx" : "/tmp-outside/outside-brigade.docx";
		// Use a path that is NOT under the test workspace/temp roots. On POSIX a
		// nonexistent /tmp-outside path resolves outside; the guard refuses before
		// the read. On Windows C:\Users\Public is outside the temp workspace.
		await assert.rejects(
			() => ed().execute("e", { source: outside, action: "replace_text", find: "a", replace: "b" }),
			/allowed roots|not found|sensitive|system/i,
		);
	});

	it("refuses writing the output outside the allowed roots", async () => {
		const src = await makeDoc("docx", { sections: [{ paragraphs: ["x"] }] }, "ok.docx");
		const outside =
			process.platform === "win32" ? "C:\\Windows\\Temp\\evil-out.docx" : "/etc/evil-out.docx";
		await assert.rejects(
			() =>
				ed().execute("e", {
					source: src,
					action: "replace_text",
					find: "x",
					replace: "y",
					outputPath: outside,
				}),
			/allowed roots|sensitive|system/i,
		);
	});

	it("a source with an unknown extension and no format → clean error", async () => {
		const weird = path.join(workspace, "mystery.bin");
		fs.writeFileSync(weird, Buffer.from("not a doc"));
		await assert.rejects(
			() => ed().execute("e", { source: weird, action: "replace_text", find: "a", replace: "b" }),
			/determine the document format/i,
		);
	});

	it("a corrupt .docx surfaces a clean error (not a raw library throw)", async () => {
		const fake = path.join(workspace, "fake.docx");
		fs.writeFileSync(fake, Buffer.from("this is not a zip"));
		await assert.rejects(
			() => ed().execute("e", { source: fake, action: "replace_text", find: "a", replace: "b" }),
			(err: unknown) => err instanceof BrigadeToolInputError,
		);
	});
});

/* ─────────────────────────── pure helpers ─────────────────────────── */

describe("parsePageList", () => {
	it("parses single pages, ranges, and open-ended ranges within [1,total]", () => {
		assert.deepEqual(parsePageList("1,3,5", 10), [1, 3, 5]);
		assert.deepEqual(parsePageList("2-4", 10), [2, 3, 4]);
		assert.deepEqual(parsePageList("8-", 10), [8, 9, 10]);
		assert.deepEqual(parsePageList("-3", 10), [1, 2, 3]);
	});
	it("clamps to total + de-dupes + sorts + skips garbage", () => {
		assert.deepEqual(parsePageList("5-100", 6), [5, 6]);
		assert.deepEqual(parsePageList("3,3,1,abc, ,2", 10), [1, 2, 3]);
		assert.deepEqual(parsePageList("", 10), []);
	});
});

describe("replaceInRunText", () => {
	it("replaces text inside <w:t> runs and counts occurrences", () => {
		const xml = "<w:p><w:r><w:t>foo BAR baz BAR</w:t></w:r></w:p>";
		const { xml: out, count } = replaceInRunText(xml, "BAR", "QUX");
		assert.equal(count, 2);
		assert.match(out, /foo QUX baz QUX/);
	});
	it("re-escapes XML-special replacement text", () => {
		const xml = "<a:t>hello TOKEN</a:t>";
		const { xml: out } = replaceInRunText(xml, "TOKEN", "a < b & c");
		assert.match(out, /a &lt; b &amp; c/);
	});
	it("leaves non-matching runs untouched and counts zero", () => {
		const xml = "<w:t>nothing here</w:t>";
		const { xml: out, count } = replaceInRunText(xml, "ZZZ", "x");
		assert.equal(count, 0);
		assert.equal(out, xml);
	});
});
