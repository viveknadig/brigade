/**
 * `edit_document` — EDIT an existing Word / Excel / PowerPoint / PDF file in
 * place (or to a sibling). The high-fidelity counterpart to `make_document`:
 * where create builds a file from scratch, edit OPENS an existing one and
 * mutates it, preserving the parts it does not touch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HIGH-FIDELITY TECHNIQUE (read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * Two strategies depending on format + action:
 *
 *   • docx/pptx `replace_text` → the OOXML UNZIP→edit-XML→REZIP technique
 *     (the same one `analyze_media` reads with): `fflate.unzipSync` the file,
 *     run a string replacement over the text runs in `word/document.xml`
 *     (docx) or every `ppt/slides/slideN.xml` (pptx), then `fflate.zipSync`
 *     the entries back. This preserves ALL styling, themes, images, and
 *     relationships — only the run text changes. (A full `docx patchDocument`
 *     token-replace is available too via the `docx` lib, but the unzip-rezip
 *     path keeps arbitrary existing formatting that patchDocument would not
 *     round-trip, and works identically for pptx which has no patch API.)
 *
 *   • docx `append` → re-open is not needed: we unzip, splice new paragraph
 *     XML before `</w:body>`, and rezip — additive, style-preserving.
 *
 *   • xlsx `set_cells` / `append_rows` → `exceljs` read→modify→write, which
 *     preserves the other sheets + their formatting.
 *
 *   • pdf `fill_form` / `merge` / `split` / `stamp` / `add_pages` /
 *     `remove_pages` → `@cantoo/pdf-lib` load→mutate→save.
 *
 * SECURITY: the SOURCE path is scoped with the SAME guard as `analyze_media`'s
 * local reads (`acquireSourceBytes`), and the OUTPUT path with the same write
 * guard as `make_document` (`resolveOutputPath`). Reading a source OR writing an
 * output outside the allowed roots is refused. Default output overwrites the
 * source. NOT owner-only — editing a workspace file is safe and the path guards
 * are the boundary.
 *
 * Robust to malformed input: every failure surfaces as a `BrigadeToolInputError`
 * (clean `.message` to the model), never a raw library throw.
 */

import path from "node:path";

import { Type, type Static } from "typebox";

import { BrigadeToolInputError, jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";
import {
	acquireSourceBytes,
	formatFromExtension,
	resolveOutputPath,
	writeDocFile,
	type DocFormat,
} from "./doc-shared.js";

/** Hard cap on a single source/merge-input file read for editing. */
const MAX_SOURCE_BYTES = 48 * 1024 * 1024; // 48 MiB

/* ─────────────────────────── params ─────────────────────────── */

const CellEdit = Type.Object({
	ref: Type.Optional(Type.String({ description: 'A1-style cell reference (e.g. "B3"). Use this OR row+col.' })),
	row: Type.Optional(Type.Integer({ minimum: 1, description: "1-based row index (with `col`)." })),
	col: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column index (with `row`)." })),
	value: Type.Union([Type.String(), Type.Number()], { description: "New cell value." }),
});

const EditDocumentParams = Type.Object({
	source: Type.String({
		description:
			"Path to the EXISTING document to edit (scoped to allowed roots: workspace / cwd / cache / temp). Format is detected from the extension unless `format` is set.",
	}),
	format: Type.Optional(
		Type.Union(
			[Type.Literal("docx"), Type.Literal("xlsx"), Type.Literal("pptx"), Type.Literal("pdf")],
			{ description: "Override the format if the extension is wrong/missing." },
		),
	),
	action: Type.String({
		description:
			"What to do. docx: append | replace_text. xlsx: set_cells | append_rows. pptx: replace_text. pdf: fill_form | merge | split | stamp | watermark | add_pages | remove_pages.",
	}),
	outputPath: Type.Optional(
		Type.String({
			description:
				"Where to write the result. Omit to OVERWRITE the source. Relative paths resolve against the workspace; must land inside an allowed root. (split ignores this and writes numbered siblings of the source.)",
		}),
	),
	// replace_text (docx/pptx)
	find: Type.Optional(Type.String({ description: "replace_text: the text to find (literal)." })),
	replace: Type.Optional(Type.String({ description: "replace_text: the replacement text." })),
	// append (docx)
	paragraphs: Type.Optional(
		Type.Array(Type.String(), { description: "append (docx): paragraphs to add at the end." }),
	),
	heading: Type.Optional(Type.String({ description: "append (docx): an optional heading before the new paragraphs." })),
	// set_cells / append_rows (xlsx)
	sheet: Type.Optional(Type.String({ description: "xlsx: target sheet name (default: the first sheet)." })),
	cells: Type.Optional(Type.Array(CellEdit, { description: "set_cells: the cells to update." })),
	rows: Type.Optional(
		Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()])), {
			description: "append_rows: rows to append to the sheet.",
		}),
	),
	// fill_form (pdf)
	fields: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
			description: "fill_form: { fieldName: value } — text fields set text, checkboxes accept true/false.",
		}),
	),
	// merge (pdf)
	pdfs: Type.Optional(
		Type.Array(Type.String(), { description: "merge: additional PDF paths to append AFTER the source." }),
	),
	// split (pdf)
	pages: Type.Optional(
		Type.String({
			description:
				'split: page ranges to extract, comma-separated (e.g. "1-3,5,8-"). Each range → one output file. remove_pages: pages to delete (same syntax).',
		}),
	),
	// stamp / watermark (pdf)
	text: Type.Optional(Type.String({ description: "stamp/watermark: the text to overlay on every page." })),
});

export interface EditDocumentDetails {
	ok: boolean;
	action: string;
	format: DocFormat;
	path?: string;
	paths?: string[];
	bytes?: number;
	pages?: number;
	replacements?: number;
	cellsSet?: number;
	rowsAppended?: number;
	fieldsSet?: number;
	warning?: string;
	message?: string;
}

/* ─────────────────────────── tool factory ─────────────────────────── */

export interface MakeEditDocumentToolOptions {
	workspaceDir?: string;
	cwd?: string;
	agentId?: string;
}

export function makeEditDocumentTool(
	opts: MakeEditDocumentToolOptions = {},
): BrigadeTool<typeof EditDocumentParams, EditDocumentDetails> {
	const rootOpts = {
		...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	};

	return {
		name: "edit_document",
		label: "Edit Document",
		displaySummary: "editing a document",
		ownerOnly: false,
		description: [
			"Edit an EXISTING Word (docx), Excel (xlsx), PowerPoint (pptx), or PDF file, preserving the parts you don't change.",
			"Pass `source` (the file), `action`, and the action's params. docx: append ({paragraphs,heading?}) | replace_text ({find,replace}). xlsx: set_cells ({sheet?,cells:[{ref|row,col, value}]}) | append_rows ({sheet?,rows}). pptx: replace_text ({find,replace}). pdf: fill_form ({fields}) | merge ({pdfs}) | split ({pages}) | stamp/watermark ({text}) | add_pages ({pdfs}) | remove_pages ({pages}).",
			"Writes back over the source by default (pass `outputPath` for a copy). To create a NEW file from scratch use `make_document`; to send the result use `send_media({path})`.",
		].join(" "),
		parameters: EditDocumentParams,
		execute: async (
			_toolCallId,
			args: Static<typeof EditDocumentParams>,
			signal,
		): Promise<AgentToolResult<EditDocumentDetails>> => {
			void signal;
			const source = (args.source ?? "").trim();
			if (!source) throw new BrigadeToolInputError("source required");
			const format = (args.format as DocFormat | undefined) ?? formatFromExtension(source);
			if (!format) {
				throw new BrigadeToolInputError(
					"could not determine the document format from the source extension — pass `format` (docx/xlsx/pptx/pdf).",
				);
			}
			const action = (args.action ?? "").trim().toLowerCase();
			if (!action) throw new BrigadeToolInputError("action required");

			// Read the source (guarded + scoped).
			const sourceBytes = await acquireSourceBytes(source, { ...rootOpts, maxBytes: MAX_SOURCE_BYTES });

			// Resolve the output path (default: overwrite the source). `split` is the
			// one action that writes multiple siblings, handled inside its branch.
			const outRaw =
				typeof args.outputPath === "string" && args.outputPath.trim() ? args.outputPath.trim() : source;
			const absOut = action === "split" ? source : resolveOutputPath(outRaw, rootOpts);

			let result: AgentToolResult<EditDocumentDetails>;
			switch (format) {
				case "docx":
					result = await editDocx(action, sourceBytes, absOut, args, rootOpts);
					break;
				case "pptx":
					result = await editPptx(action, sourceBytes, absOut, args);
					break;
				case "xlsx":
					result = await editXlsx(action, sourceBytes, absOut, args);
					break;
				case "pdf":
					result = await editPdf(action, sourceBytes, source, absOut, args, rootOpts);
					break;
			}
			return result;
		},
	};
}

/* ─────────────────────────── docx edits ─────────────────────────── */

async function editDocx(
	action: string,
	bytes: Buffer,
	absOut: string,
	args: Static<typeof EditDocumentParams>,
	rootOpts: { workspaceDir?: string; cwd?: string },
): Promise<AgentToolResult<EditDocumentDetails>> {
	void rootOpts;
	if (action === "replace_text") {
		const find = args.find ?? "";
		if (!find) throw new BrigadeToolInputError("replace_text: `find` is required.");
		const replace = args.replace ?? "";
		const { entries, decode, encode } = await unzipDoc(bytes, "docx");
		const docXml = entries["word/document.xml"];
		if (!docXml) throw new BrigadeToolInputError("not a valid .docx (missing word/document.xml).");
		const { xml, count } = replaceInRunText(decode(docXml), find, replace);
		entries["word/document.xml"] = encode(xml);
		const out = await rezipDoc(entries);
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "docx", path: absOut, bytes: written, replacements: count });
	}
	if (action === "append") {
		const paragraphs = (args.paragraphs ?? []).filter((p) => typeof p === "string");
		const heading = typeof args.heading === "string" ? args.heading.trim() : "";
		if (paragraphs.length === 0 && !heading) {
			throw new BrigadeToolInputError("append: provide `paragraphs` (and/or a `heading`).");
		}
		const { entries, decode, encode } = await unzipDoc(bytes, "docx");
		const docXml = entries["word/document.xml"];
		if (!docXml) throw new BrigadeToolInputError("not a valid .docx (missing word/document.xml).");
		let xml = decode(docXml);
		const additions: string[] = [];
		if (heading) {
			additions.push(
				`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(heading)}</w:t></w:r></w:p>`,
			);
		}
		for (const para of paragraphs) {
			additions.push(
				`<w:p><w:r><w:t xml:space="preserve">${escapeXml(String(para ?? ""))}</w:t></w:r></w:p>`,
			);
		}
		const insert = additions.join("");
		// Splice BEFORE the final sectPr (page setup) when present, else before </w:body>.
		const sectPrIdx = xml.lastIndexOf("<w:sectPr");
		const bodyClose = xml.lastIndexOf("</w:body>");
		if (sectPrIdx !== -1 && sectPrIdx < bodyClose) {
			xml = xml.slice(0, sectPrIdx) + insert + xml.slice(sectPrIdx);
		} else if (bodyClose !== -1) {
			xml = xml.slice(0, bodyClose) + insert + xml.slice(bodyClose);
		} else {
			throw new BrigadeToolInputError("not a valid .docx (no <w:body> to append into).");
		}
		entries["word/document.xml"] = encode(xml);
		const out = await rezipDoc(entries);
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "docx", path: absOut, bytes: written });
	}
	throw new BrigadeToolInputError(`unsupported docx action "${action}". Use: append, replace_text.`);
}

/* ─────────────────────────── pptx edits ─────────────────────────── */

async function editPptx(
	action: string,
	bytes: Buffer,
	absOut: string,
	args: Static<typeof EditDocumentParams>,
): Promise<AgentToolResult<EditDocumentDetails>> {
	if (action === "replace_text" || action === "edit_slide") {
		const find = args.find ?? "";
		if (!find) throw new BrigadeToolInputError("replace_text: `find` is required.");
		const replace = args.replace ?? "";
		const { entries, decode, encode } = await unzipDoc(bytes, "pptx");
		const slideNames = Object.keys(entries).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
		if (slideNames.length === 0) throw new BrigadeToolInputError("not a valid .pptx (no slides found).");
		let total = 0;
		for (const name of slideNames) {
			const xml = decode(entries[name] as Uint8Array);
			const { xml: next, count } = replaceInRunText(xml, find, replace);
			if (count > 0) entries[name] = encode(next);
			total += count;
		}
		const out = await rezipDoc(entries);
		const written = await writeDocFile(absOut, out);
		return ok({ action: "replace_text", format: "pptx", path: absOut, bytes: written, replacements: total });
	}
	throw new BrigadeToolInputError(`unsupported pptx action "${action}". Use: replace_text.`);
}

/* ─────────────────────────── xlsx edits ─────────────────────────── */

async function editXlsx(
	action: string,
	bytes: Buffer,
	absOut: string,
	args: Static<typeof EditDocumentParams>,
): Promise<AgentToolResult<EditDocumentDetails>> {
	const ExcelJSImport = await import("exceljs");
	const ExcelJS =
		(ExcelJSImport as unknown as { default?: typeof ExcelJSImport }).default ?? ExcelJSImport;
	const wb = new ExcelJS.Workbook();
	try {
		// exceljs's bundled types expect a non-generic Buffer; @types/node's Buffer
		// is generic over ArrayBufferLike. Cast at the boundary — the value is a
		// real Node Buffer at runtime.
		await wb.xlsx.load(bytes as never);
	} catch {
		throw new BrigadeToolInputError("could not read the .xlsx (corrupt or not a real spreadsheet).");
	}
	const sheet = args.sheet && args.sheet.trim() ? wb.getWorksheet(args.sheet.trim()) : wb.worksheets[0];
	if (!sheet) {
		const names = wb.worksheets.map((w) => w.name).join(", ") || "(none)";
		throw new BrigadeToolInputError(`sheet not found. Available sheets: ${names}.`);
	}

	if (action === "set_cells") {
		const cells = args.cells ?? [];
		if (cells.length === 0) throw new BrigadeToolInputError("set_cells: `cells` is required.");
		let n = 0;
		for (const c of cells) {
			const value = typeof c.value === "number" ? c.value : String(c.value ?? "");
			if (typeof c.ref === "string" && c.ref.trim()) {
				sheet.getCell(c.ref.trim().toUpperCase()).value = value;
				n += 1;
			} else if (typeof c.row === "number" && typeof c.col === "number") {
				sheet.getCell(c.row, c.col).value = value;
				n += 1;
			} else {
				throw new BrigadeToolInputError("each cell needs either `ref` or both `row` and `col`.");
			}
		}
		const out = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "xlsx", path: absOut, bytes: written, cellsSet: n });
	}
	if (action === "append_rows") {
		const rows = args.rows ?? [];
		if (rows.length === 0) throw new BrigadeToolInputError("append_rows: `rows` is required.");
		for (const row of rows) {
			sheet.addRow((row ?? []).map((c) => (typeof c === "number" ? c : String(c ?? ""))));
		}
		const out = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "xlsx", path: absOut, bytes: written, rowsAppended: rows.length });
	}
	throw new BrigadeToolInputError(`unsupported xlsx action "${action}". Use: set_cells, append_rows.`);
}

/* ─────────────────────────── pdf edits ─────────────────────────── */

async function editPdf(
	action: string,
	bytes: Buffer,
	source: string,
	absOut: string,
	args: Static<typeof EditDocumentParams>,
	rootOpts: { workspaceDir?: string; cwd?: string },
): Promise<AgentToolResult<EditDocumentDetails>> {
	const pdfLib = await import("@cantoo/pdf-lib");
	const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;

	const load = async (buf: Buffer): Promise<Awaited<ReturnType<typeof PDFDocument.load>>> => {
		try {
			return await PDFDocument.load(buf);
		} catch {
			throw new BrigadeToolInputError("could not read the PDF (corrupt or password-protected?).");
		}
	};

	if (action === "fill_form") {
		const fields = args.fields ?? {};
		const names = Object.keys(fields);
		if (names.length === 0) throw new BrigadeToolInputError("fill_form: `fields` is required.");
		const pdf = await load(bytes);
		const form = pdf.getForm();
		let set = 0;
		const missing: string[] = [];
		for (const name of names) {
			const value = fields[name];
			try {
				const field: unknown = findField(form, name);
				if (!field) {
					missing.push(name);
					continue;
				}
				const kind = (field as { constructor?: { name?: string } }).constructor?.name ?? "";
				const f = field as {
					check?: () => void;
					uncheck?: () => void;
					setText?: (t: string) => void;
					select?: (t: string) => void;
				};
				if (kind.includes("CheckBox") && typeof f.check === "function") {
					if (value === true || value === "true" || value === 1) f.check();
					else if (typeof f.uncheck === "function") f.uncheck();
				} else if (typeof f.setText === "function") {
					f.setText(String(value ?? ""));
				} else if (typeof f.select === "function") {
					f.select(String(value ?? ""));
				} else {
					missing.push(name);
					continue;
				}
				set += 1;
			} catch {
				missing.push(name);
			}
		}
		const out = Buffer.from(await pdf.save());
		const written = await writeDocFile(absOut, out);
		const details: EditDocumentDetails = {
			ok: true,
			action,
			format: "pdf",
			path: absOut,
			bytes: written,
			fieldsSet: set,
			pages: pdf.getPageCount(),
		};
		if (missing.length > 0) details.warning = `Fields not found / unsettable: ${missing.join(", ")}.`;
		return jsonResult(details) as AgentToolResult<EditDocumentDetails>;
	}

	if (action === "merge" || action === "add_pages") {
		const extra = (args.pdfs ?? []).filter((p) => typeof p === "string" && p.trim());
		if (extra.length === 0) throw new BrigadeToolInputError(`${action}: \`pdfs\` (paths to append) is required.`);
		const merged = await load(bytes);
		for (const p of extra) {
			const buf = await acquireSourceBytes(p.trim(), { ...rootOpts, maxBytes: MAX_SOURCE_BYTES });
			const next = await load(buf);
			const copied = await merged.copyPages(next, next.getPageIndices());
			for (const page of copied) merged.addPage(page);
		}
		const out = Buffer.from(await merged.save());
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "pdf", path: absOut, bytes: written, pages: merged.getPageCount() });
	}

	if (action === "remove_pages") {
		const spec = args.pages ?? "";
		if (!spec.trim()) throw new BrigadeToolInputError("remove_pages: `pages` is required (e.g. \"2,4-5\").");
		const pdf = await load(bytes);
		const total = pdf.getPageCount();
		const toRemove = new Set(parsePageList(spec, total));
		if (toRemove.size === 0) throw new BrigadeToolInputError("remove_pages: no valid pages in that range.");
		if (toRemove.size >= total) throw new BrigadeToolInputError("remove_pages: refusing to remove every page.");
		// Remove from the highest index down so earlier indices stay valid.
		for (const num of [...toRemove].sort((a, b) => b - a)) pdf.removePage(num - 1);
		const out = Buffer.from(await pdf.save());
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "pdf", path: absOut, bytes: written, pages: pdf.getPageCount() });
	}

	if (action === "split") {
		const spec = args.pages ?? "";
		if (!spec.trim()) throw new BrigadeToolInputError("split: `pages` is required (e.g. \"1-3,5,8-\").");
		const pdf = await load(bytes);
		const total = pdf.getPageCount();
		const ranges = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		const dir = path.dirname(source);
		const base = path.basename(source, path.extname(source));
		const outPaths: string[] = [];
		let part = 0;
		for (const range of ranges) {
			const nums = parsePageList(range, total);
			if (nums.length === 0) continue;
			part += 1;
			const sub = await PDFDocument.create();
			const copied = await sub.copyPages(pdf, nums.map((n) => n - 1));
			for (const page of copied) sub.addPage(page);
			const outName = path.join(dir, `${base}-part${part}.pdf`);
			const abs = resolveOutputPath(outName, rootOpts);
			const out = Buffer.from(await sub.save());
			await writeDocFile(abs, out);
			outPaths.push(abs);
		}
		if (outPaths.length === 0) throw new BrigadeToolInputError("split: no valid page ranges produced output.");
		const details: EditDocumentDetails = { ok: true, action, format: "pdf", paths: outPaths };
		return jsonResult(details) as AgentToolResult<EditDocumentDetails>;
	}

	if (action === "stamp" || action === "watermark") {
		const text = (args.text ?? "").trim();
		if (!text) throw new BrigadeToolInputError(`${action}: \`text\` is required.`);
		const pdf = await load(bytes);
		const font = await pdf.embedFont(StandardFonts.HelveticaBold);
		const safe = text.replace(/[^\x20-\x7e]/g, "?");
		const isWatermark = action === "watermark";
		for (const page of pdf.getPages()) {
			const { width, height } = page.getSize();
			if (isWatermark) {
				const size = Math.max(24, Math.min(72, Math.floor(width / 10)));
				page.drawText(safe, {
					x: width * 0.15,
					y: height * 0.45,
					size,
					font,
					color: rgb(0.6, 0.6, 0.6),
					rotate: degrees(45),
					opacity: 0.3,
				});
			} else {
				const size = 12;
				page.drawText(safe, { x: 40, y: 20, size, font, color: rgb(0.3, 0.3, 0.3), opacity: 0.7 });
			}
		}
		const out = Buffer.from(await pdf.save());
		const written = await writeDocFile(absOut, out);
		return ok({ action, format: "pdf", path: absOut, bytes: written, pages: pdf.getPageCount() });
	}

	throw new BrigadeToolInputError(
		`unsupported pdf action "${action}". Use: fill_form, merge, split, stamp, watermark, add_pages, remove_pages.`,
	);
}

/** pdf-lib form field lookup tolerant of versions without getFieldMaybe. */
function findField(form: { getFields(): Array<{ getName(): string }> }, name: string): { getName(): string } | undefined {
	try {
		return form.getFields().find((f) => f.getName() === name);
	} catch {
		return undefined;
	}
}

/* ─────────────────────────── OOXML unzip / rezip ─────────────────────────── */

interface UnzippedDoc {
	entries: Record<string, Uint8Array>;
	decode: (u8: Uint8Array) => string;
	encode: (s: string) => Uint8Array;
}

/** Unzip an OOXML file with fflate; clean error on a non-zip / corrupt input. */
async function unzipDoc(bytes: Buffer, kind: "docx" | "pptx"): Promise<UnzippedDoc> {
	const { unzipSync, strFromU8, strToU8 } = await import("fflate");
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(new Uint8Array(bytes)) as unknown as Record<string, Uint8Array>;
	} catch {
		throw new BrigadeToolInputError(
			`could not read the file as a .${kind} (corrupt, password-protected, or not a real Office document).`,
		);
	}
	return {
		entries,
		decode: (u8) => strFromU8(u8),
		encode: (s) => strToU8(s),
	};
}

/** Re-zip OOXML entries back into a single buffer. */
async function rezipDoc(entries: Record<string, Uint8Array>): Promise<Buffer> {
	const { zipSync } = await import("fflate");
	const out = zipSync(entries);
	return Buffer.from(out);
}

/**
 * Replace `find` with `replace` inside the TEXT of OOXML run elements
 * (`<w:t>` / `<a:t>` / bare `<t>`), leaving all tags + attributes intact. The
 * search is performed on the DECODED text of each run, so a match that does not
 * span runs is replaced faithfully; the replacement is re-escaped. Matches that
 * are split across multiple runs (Word sometimes fragments a word) are not
 * caught — that is the known limitation of run-level replacement, and it never
 * corrupts the file.
 */
export function replaceInRunText(
	xml: string,
	find: string,
	replace: string,
): { xml: string; count: number } {
	if (!find) return { xml, count: 0 };
	let count = 0;
	const runRe = /(<(?:[a-zA-Z]+:)?t(?:\s[^>]*)?>)([\s\S]*?)(<\/(?:[a-zA-Z]+:)?t>)/g;
	const next = xml.replace(runRe, (_m, open: string, inner: string, close: string) => {
		const decoded = decodeXmlBasic(inner);
		if (!decoded.includes(find)) return _m;
		const replaced = decoded.split(find).join(replace);
		count += decoded.split(find).length - 1;
		return `${open}${escapeXml(replaced)}${close}`;
	});
	return { xml: next, count };
}

/** Decode the 5 predefined XML entities (enough for run text comparison). */
function decodeXmlBasic(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Escape text for inclusion in XML content. */
function escapeXml(s: string): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/* ─────────────────────────── page-list parsing ─────────────────────────── */

/**
 * Parse a 1-indexed page list like "1-3,5,8-" into a sorted, de-duped array of
 * page numbers within [1, total]. Invalid fragments are skipped (never throws).
 * Exported for tests.
 */
export function parsePageList(spec: string, total: number): number[] {
	const out = new Set<number>();
	for (const frag of String(spec ?? "").split(",")) {
		const s = frag.trim();
		if (!s) continue;
		const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(s);
		if (m && (m[1] || m[2])) {
			const lo = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
			const hi = m[2] ? Math.min(total, parseInt(m[2], 10)) : total;
			for (let n = lo; n <= hi; n++) if (n >= 1 && n <= total) out.add(n);
			continue;
		}
		if (/^\d+$/.test(s)) {
			const n = parseInt(s, 10);
			if (n >= 1 && n <= total) out.add(n);
		}
	}
	return [...out].sort((a, b) => a - b);
}

/* ─────────────────────────── result helper ─────────────────────────── */

function ok(d: Omit<EditDocumentDetails, "ok">): AgentToolResult<EditDocumentDetails> {
	return jsonResult({ ...d, ok: true }) as AgentToolResult<EditDocumentDetails>;
}
