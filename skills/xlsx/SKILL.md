---
name: xlsx
description: Build and edit professional Excel (.xlsx) spreadsheets, workbooks, and simple financial models — live formulas, number/date/currency formats, cell styling, conditional formatting, data-validation dropdowns, named ranges, frozen panes, merged cells, multi-sheet. Use when the user asks Brigade to make, fill, update, model, or edit a spreadsheet, workbook, or .xlsx file.
metadata:
  {
    "brigade":
      {
        "emoji": "📊"
      }
  }
---

# xlsx — professional spreadsheets & models

| Need | Path |
|------|------|
| Simple table / multi-sheet dump (headers + rows, optional per-column number format) | **Path 1 — `make_document` tool** |
| Live formulas, cell styling, conditional formatting, dropdowns, named ranges, freeze panes, merged cells, dates | **Path 2 — script the `exceljs` library via `brigade exec-node`** |
| Surgical edits to an existing workbook | **Path 3 — `edit_document` tool** |
| Guarantee no formula errors / get computed values | **Path 4 — recalc-verify loop (optional `soffice`)** |

**The two non-negotiable rules** (they separate a real model from a hack):
1. **Formulas, never hardcoded results.** Write the Excel formula string (`=B5*(1+$B$6)`), never compute the number in code and paste a literal — so the sheet stays live when inputs change. This applies to every total, percentage, ratio, and growth.
2. **Numbers are numbers.** Store `1200000`, format for display (`$#,##0`) — never the string `"$1.2M"`, or it won't sum or sort.

---

## Path 1 — quick table (`make_document` tool)

```
make_document(format="xlsx", content={ sheets:[{ name, header, rows, numberFormats }] })
```
Cells may be `string | number | {formula, numFmt}`. Fine for a straight data table. For styling, validation, charts, or a model → Path 2.

## Path 2 — full power: script the `exceljs` library

Brigade bundles **`exceljs`**. `write` a `gen.cjs`, then run `brigade exec-node gen.cjs`:

```js
// gen.cjs — illustrative
const ExcelJS = require("exceljs");
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Model", { views: [{ state: "frozen", ySplit: 1 }] });   // freeze header row

ws.columns = [
  { header: "Item", key: "item", width: 28 },
  { header: "FY24 ($)", key: "v", width: 16, style: { numFmt: "$#,##0" } },
];
ws.getRow(1).font = { bold: true };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };

// Assumptions block — blue font marks hardcoded INPUTS (banker convention)
ws.getCell("E1").value = "Growth"; ws.getCell("E2").value = 0.18;
ws.getCell("E2").numFmt = "0.0%"; ws.getCell("E2").font = { color: { argb: "FF0000FF" } };
wb.definedNames.add("Model!$E$2", "growth");                                        // named range

ws.addRow({ item: "Revenue", v: 1200000 });
ws.addRow({ item: "Next year", v: { formula: "B2*(1+growth)" } });                  // FORMULA, references the named input
ws.getCell("B3").font = { color: { argb: "FF000000" } };                            // black = formula

// dropdown + conditional formatting
ws.getCell("A6").dataValidation = { type: "list", allowBlank: false, formulae: ['"Low,Med,High"'] };
ws.addConditionalFormatting({ ref: "B2:B3", rules: [
  { type: "cellIs", operator: "lessThan", formulae: ["0"], style: { font: { color: { argb: "FFFF0000" } } } } ]});

wb.xlsx.writeFile(process.argv[2] || "out.xlsx").then(() => console.log("wrote"));
```

`exceljs` covers: number/date formats, font/fill/border/alignment, conditional formatting, data-validation dropdowns, named ranges, freeze panes, autofilter, merged cells, images, sheet protection, multi-sheet. Dates: pass a real `new Date(...)` and set a date `numFmt` (don't pass a string).

## Path 3 — edit an existing workbook (`edit_document` tool)

- `set_cells {sheet?, cells:[{ref|row,col, value, numFmt?}]}` — surgical edits; other sheets untouched.
- `append_rows {sheet?, rows}` — grow a table.
When editing someone's workbook, **match its existing conventions exactly** (column order, units, formats) — the template always wins over the defaults here.

## Path 4 — recalc-verify loop (the quality guarantee)

`exceljs` stores formula **strings but does not evaluate them** — a typo (`#REF!`, `#DIV/0!`) is invisible until the file is opened. If LibreOffice is present, force a recalc and inspect; otherwise hand-check ranges and keep formulas simple.

```bash
command -v soffice >/dev/null 2>&1 && soffice --headless --convert-to pdf --outdir /tmp out.xlsx   # then read the PDF: no #REF!/#DIV/0! anywhere
```
Loop: build → recalc → if any error token appears, fix the formula → recalc again. Target: **zero formula errors** in the delivered file.

## Conventions (banker-grade, optional but professional)

- Cell-color convention: **blue font = hardcoded inputs**, black = formulas, green = links to other sheets, red = links to external files; yellow fill = key assumptions.
- Isolate assumptions in their own cells and reference them **absolutely** (`$B$6`) or by **named range**; document any sourced hardcode in a cell comment ("Source: 10-K FY24 p.45").
- Number formats: currency `$#,##0` with units in the header; percentages `0.0%`; multiples `0.0x`; negatives in parentheses; years as text.

## Verify (required)

Re-open with `edit_document`/read or confirm the file unzips with the expected sheet names; if you used formulas, run the Path-4 recalc and confirm zero errors before declaring done.
