---
name: pdf
description: Create and edit PDFs to a professional standard — generate from content, draw vector/precise layouts, embed custom (incl. CJK/Unicode) fonts, CREATE and fill AcroForm fields (text/checkbox/radio/dropdown), flatten, merge/split/rotate, stamp/watermark, encrypt, and extract text. Use when the user asks Brigade to make a PDF, fill or build a PDF form, or combine/split/stamp/secure PDFs.
metadata:
  {
    "brigade":
      {
        "emoji": "📄"
      }
  }
---

# pdf — professional PDFs

| Need | Path |
|------|------|
| Simple content PDF (title, headings, paragraphs, image) | **Path 1 — `make_document` tool** |
| Fill an existing form, merge/split/stamp/watermark | **Path 2 — `edit_document` tool** |
| Form-field CREATION, vector drawing, embedded fonts (bold/CJK), precise layout, encryption, page surgery | **Path 3 — script `@cantoo/pdf-lib` via `brigade exec-node`** |
| Pixel-perfect, brand-styled layout from HTML/CSS | **Path 4 — HTML→PDF (optional binary)** |

> Note: PDF is a *final* format with no reflow engine. If the recipient must edit, deliver the editable source (`.docx`/`.xlsx`) **and** the PDF.

---

## Path 1 — quick content PDF (`make_document` tool)

```
make_document(format="pdf", content={ title, pages:[{ heading, paragraphs, image:{path} }] })
```
Flow layout, US-Letter, single column, word-wrapped. Good for reports/summaries/letters. For forms, precise layout, or custom fonts → Path 3.

## Path 2 — edit an existing PDF (`edit_document` tool)

- `fill_form {fields}` — fill existing AcroForm fields by name (text/checkbox/dropdown).
- `merge {pdfs}` / `add_pages {pdfs}` · `split {pages}` · `remove_pages {pages}`.
- `stamp {text}` · `watermark {text}` (45° translucent).

**Form decision:** first detect whether the PDF has real fillable fields. If it does → fill them (clean, type-validated). If it's a flat/scanned form (no fields) → you must draw text at coordinates instead (Path 3, annotations) — never assume fields exist.

## Path 3 — full power: script `@cantoo/pdf-lib`

Brigade bundles **`@cantoo/pdf-lib`** (a maintained pdf-lib fork — note the scoped name) plus **`@pdf-lib/fontkit`** (custom-font embedding) and **`unpdf`** (text extraction). `write` a `gen.cjs`, run `brigade exec-node gen.cjs`:

```js
// gen.cjs — illustrative
const fs = require("node:fs");
const { PDFDocument, StandardFonts, rgb } = require("@cantoo/pdf-lib");

(async () => {
  const pdf = await PDFDocument.create();

  // embed a custom font (real bold / CJK / Unicode) — requires fontkit
  // const fontkit = require("@pdf-lib/fontkit"); pdf.registerFontkit(fontkit);
  // const font = await pdf.embedFont(fs.readFileSync("Brand-Bold.ttf"));
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([612, 792]);                 // US Letter; origin is BOTTOM-LEFT, y-up
  page.drawText("Invoice", { x: 54, y: 720, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawRectangle({ x: 54, y: 700, width: 504, height: 1, color: rgb(0.8, 0.8, 0.8) }); // vector rule

  // CREATE fillable form fields
  const form = pdf.getForm();
  const name = form.createTextField("client.name");
  name.addToPage(page, { x: 120, y: 640, width: 300, height: 18 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 54, y: 600, width: 14, height: 14 });
  // form.flatten();                                     // bake fields into static content if no further filling

  fs.writeFileSync(process.argv[2] || "out.pdf", await pdf.save());
  console.log("wrote");
})();
```

`@cantoo/pdf-lib` covers: draw text/lines/rects/ellipses/SVG paths/images; embed custom TTF/OTF fonts (subset, full Unicode); **create AND fill** AcroForm text/checkbox/radio/dropdown/option-list fields; flatten; copy/merge/split/rotate pages; metadata; **password encryption** (the reason this fork is bundled). Extract text/structure with `unpdf`.

**Coordinate gotcha:** pdf-lib origin is **bottom-left, y-up**. If you author field positions from a top-left image/spec, convert: `y_pdf = pageHeight - y_top - height`. One coordinate convention per script.

## Path 4 — pixel-perfect / branded PDF from HTML+CSS (optional)

pdf-lib has **no HTML/CSS layout engine** — for a designed, brand-styled document, render HTML→PDF. Use whatever is present (detect first):
```bash
command -v soffice >/dev/null 2>&1 && soffice --headless --convert-to pdf brand.html      # LibreOffice route
```
A headless browser (Puppeteer/Playwright `page.pdf()`) is the higher-fidelity alternative if installed. Prefer Path 1/3 unless the brand design genuinely requires CSS.

## Conventions

- Use real AcroForm fields when filling a fillable PDF; only fall back to drawn-text annotations for flat/scanned forms.
- Embed a font for anything beyond basic Latin — standard PDF fonts lack bold-as-a-face and all CJK/emoji (missing glyphs render as boxes).
- Keep ≥0.5" margins; align to a grid; don't rely on text reflowing (there's no engine — you place it).

## Verify (required)

Confirm the output exists and opens. For filled/created forms, re-open and read back the field values (or render to an image with `soffice`/a viewer and look at placement) before declaring done — never fill or place blind.
