---
name: docx
description: Create and edit Microsoft Word (.docx) documents to a professional standard — reports, proposals, contracts, letters, memos — with custom styles, multi-level lists, styled/merged tables, headers/footers, table of contents, hyperlinks, footnotes, tracked changes and comments. Use when the user asks Brigade to make, write, draft, fill, redline, or edit a Word document or .docx file.
metadata:
  {
    "brigade":
      {
        "emoji": "📝"
      }
  }
---

# docx — professional Word documents

Pick the lightest path that meets the need. **Never declare a document done without opening/validating the result at least once** (see *Verify*).

| Need | Path |
|------|------|
| Simple structured doc (headings, paragraphs, bullets, a basic table, an image) | **Path 1 — `make_document` tool** |
| Anything richer (custom styles, numbered/multi-level lists, merged/shaded table cells, headers/footers, TOC, hyperlinks, footnotes, inline bold/italic/color, tracked changes, comments) | **Path 2 — script the `docx` library via `brigade exec-node`** |
| Fill / redline an EXISTING branded `.docx` without disturbing its styling | **Path 3 — OOXML round-trip** |
| Markdown → branded Word inheriting a corporate template | **Path 4 — `pandoc` (optional)** |

---

## Path 1 — quick structured doc (`make_document` tool)

```
make_document(format="docx", content={ title, sections:[{heading, level, paragraphs, bullets, table:{rows}, image:{path}}] })
```
Good for a fast first draft. It is deliberately limited (single-level bullets, string-only tables, no inline formatting). The moment you need more, go to Path 2 — don't fight the schema.

## Path 2 — full power: script the `docx` library

Brigade bundles the **`docx`** library (dolanmiu/docx). Write a CommonJS script and run it with **`brigade exec-node`**, which makes Brigade's bundled libraries `require()`-able from anywhere (no install):

1. `write` a file `gen.cjs`.
2. Run: `brigade exec-node gen.cjs`

```js
// gen.cjs — illustrative; adapt to the content
const fs = require("node:fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  LevelFormat, Header, Footer, PageNumber, TableOfContents, ExternalHyperlink,
} = require("docx");

const doc = new Document({
  styles: { default: { document: { run: { font: "Calibri", size: 22 } } },     // size is half-points (22 = 11pt)
    paragraphStyles: [{ id: "Body", name: "Body", run: { size: 22 }, paragraph: { spacing: { after: 160 } } }] },
  numbering: { config: [{ reference: "nums", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }] }] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },           // US Letter, in DXA (1440 = 1 inch)
    headers: { default: new Header({ children: [new Paragraph("Acme Corp — Confidential")] }) },
    footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })] })] }) },
    children: [
      new Paragraph({ text: "Q3 Business Review", heading: HeadingLevel.TITLE }),
      new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-3" }),
      new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [ new TextRun("Revenue was "), new TextRun({ text: "$1.2M", bold: true }), new TextRun(" — up 18%.") ] }),
      new Paragraph({ text: "First item", numbering: { reference: "nums", level: 0 } }),
      new Paragraph({ children: [ new ExternalHyperlink({ children: [new TextRun({ text: "Full data", style: "Hyperlink" })], link: "https://example.com" }) ] }),
      new Table({
        columnWidths: [4680, 4680],                                            // DXA, sum = content width
        rows: [
          new TableRow({ tableHeader: true, children: ["Metric","Value"].map((t) =>
            new TableCell({ width: { size: 4680, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: "D9E2F3" },
              children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) }),
          new TableRow({ children: ["Revenue","$1.2M"].map((t) =>
            new TableCell({ width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(t)] })) }),
        ],
      }),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(process.argv[2] || "out.docx", buf); console.log("wrote", process.argv[2] || "out.docx"); });
```

The `docx` library also supports: footnotes (`FootnoteReferenceRun` + `footnotes`), comments, **tracked changes** (`InsertedTextRun`/`DeletedTextRun` with `author`/`date`), multi-section layouts, page breaks, columns, internal bookmarks, and images inside table cells. Read its API as needed — anything Word can express, this can author.

## Path 3 — fill / redline an EXISTING `.docx` (highest fidelity)

To fill a branded company template or surgically edit a real document **without regenerating it** (which would drop the theme), use the OOXML round-trip — unzip, edit the XML, rezip. For plain placeholder/text swaps the **`edit_document` tool** (`replace_text` / `fill_template` / `append`) already does exactly this and is the first choice.

For edits beyond text, script it via `brigade exec-node` with **`fflate`**:

```js
// edit.cjs — unzip → edit word/document.xml → rezip (styles/headers/theme untouched)
const fs = require("node:fs");
const { unzipSync, zipSync, strToU8, strFromU8 } = require("fflate");
const zip = unzipSync(fs.readFileSync(process.argv[2]));
let xml = strFromU8(zip["word/document.xml"]);
xml = xml.replaceAll("{{client}}", "Acme Corp");          // fill placeholders in <w:t> runs
zip["word/document.xml"] = strToU8(xml);
fs.writeFileSync(process.argv[3], zipSync(zip));
```

Rules for raw OOXML edits:
- Safe: replacing text inside `<w:t>`; pointing a run/paragraph at an **already-defined** `styleId`; appending `<w:p>`/`<w:r>` that reference existing styles.
- **Do NOT** add a new part (image, hyperlink target, header) by hand — that also needs `[Content_Types].xml` + the matching `_rels/*.rels` updated atomically, or Word reports corruption. For those, regenerate with the `docx` library instead.
- Tracked changes are `<w:ins>`/`<w:del>` as *siblings* of `<w:r>` (never inside a run); copy the original `<w:rPr>` into the change runs; keep edits minimal so an "accept all" yields exactly the intended text. Author yourself as "Brigade".

## Path 4 — Markdown → branded Word (optional, needs `pandoc`)

For long prose where the brand styling lives in a corporate `.docx`, if `pandoc` is installed it inherits every style/margin/header:
```bash
command -v pandoc >/dev/null 2>&1 && pandoc input.md --reference-doc=brand-template.docx -o out.docx
```
Detect first; else fall back to Path 2. `pandoc` is GPL — a separate program shelled out to, never bundled.

## Conventions that make output professional

- **Page size is explicit** — US Letter `12240×15840` DXA (1440 DXA = 1"); landscape = portrait dims + `orientation` flip.
- **Tables:** give both `columnWidths` (table) and per-cell `width` in **`WidthType.DXA`** (PERCENTAGE breaks some viewers), summing to content width; `ShadingType.CLEAR` (never SOLID → black boxes); add cell margins; never use a table as a horizontal rule (use a paragraph bottom border).
- **Lists:** real numbering config for numbered/multi-level lists; never paste literal "1." / "•" characters.
- Prefer bullets + tables over walls of text; one `TITLE`, then `HEADING_1..3` with proper outline levels (required for a working TOC).
- Use typographic quotes (' ' " ") and en/em dashes.

## Verify (required)

After writing, confirm the file exists and is non-trivial. If LibreOffice is available, render to PDF and **look at it** — fix overflow/placeholder leftovers, then re-verify:
```bash
command -v soffice >/dev/null 2>&1 && soffice --headless --convert-to pdf out.docx
```
TOC/page-number fields show blank until Word (or a `soffice` convert) recalculates them — note this to the user if you can't run the convert. Never declare success without at least one look-and-fix pass.
