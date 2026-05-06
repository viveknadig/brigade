import type { ContextFile } from "./types.js";

// Budgeting pass for persona files before injection.
//
// Even a well-meaning workspace can balloon — a USER.md scratch pad, an
// AGENTS.md that has accreted over months. Without a cap the system prompt
// can blow past the model's context window before the user has typed a
// single message. We keep individual files within `perFileMaxChars` and
// the combined corpus within `totalMaxChars`. When a file overflows, we
// keep a head slice and a tail slice so both the introduction and the
// "remember above all" trailing material survive.

export interface BudgetOptions {
  // Per-file char limit before head+tail truncation kicks in.
  perFileMaxChars: number;
  // Combined budget across all persona files. Files that don't fit are
  // dropped from the tail of the priority order.
  totalMaxChars: number;
  // Fraction of the per-file budget kept from the start of the file.
  headRatio: number;
  // Fraction of the per-file budget kept from the end of the file.
  // headRatio + tailRatio should be ≤ 1.0; the remainder is the elision
  // marker.
  tailRatio: number;
}

export const DEFAULT_BUDGET: BudgetOptions = {
  perFileMaxChars: 12_000,
  totalMaxChars: 60_000,
  headRatio: 0.7,
  tailRatio: 0.2,
};

export interface BudgetResult {
  files: ContextFile[];
  // Per-file diagnostics for the report subsystem.
  diagnostics: BudgetDiagnostic[];
  totalChars: number;
}

export interface BudgetDiagnostic {
  name: string;
  originalChars: number;
  finalChars: number;
  truncated: boolean;
  dropped: boolean;
}

export function applyBudget(
  files: ContextFile[],
  options: BudgetOptions = DEFAULT_BUDGET,
): BudgetResult {
  const diagnostics: BudgetDiagnostic[] = [];
  const out: ContextFile[] = [];
  let runningTotal = 0;

  for (const file of files) {
    const original = file.content;
    const originalChars = original.length;

    let content = original;
    let truncated = false;

    if (originalChars > options.perFileMaxChars) {
      content = headTailTruncate(original, options);
      truncated = true;
    }

    // If even the truncated content overflows the *total* budget, drop the
    // file. We don't try to partially fit — partial files inject ambiguous
    // signal into the model's persona. Surface a stderr warning so the
    // user notices when their persona corpus has outgrown the budget;
    // BOOTSTRAP.md silently falling out is the kind of bug that's
    // invisible to debug from the agent's reply alone.
    if (runningTotal + content.length > options.totalMaxChars) {
      diagnostics.push({
        name: file.name,
        originalChars,
        finalChars: 0,
        truncated,
        dropped: true,
      });
      console.error(
        `brigade: workspace file ${file.name} dropped from system prompt — ` +
          `total persona budget exhausted (limit ${options.totalMaxChars.toLocaleString()} chars). ` +
          `Trim earlier files or raise the budget.`,
      );
      continue;
    }

    runningTotal += content.length;
    out.push({ ...file, content });
    diagnostics.push({
      name: file.name,
      originalChars,
      finalChars: content.length,
      truncated,
      dropped: false,
    });
  }

  return { files: out, diagnostics, totalChars: runningTotal };
}

function headTailTruncate(text: string, options: BudgetOptions): string {
  const headBudget = Math.floor(options.perFileMaxChars * options.headRatio);
  const tailBudget = Math.floor(options.perFileMaxChars * options.tailRatio);
  const elidedChars = text.length - headBudget - tailBudget;
  if (elidedChars <= 0) return text;

  // Trim cleanly to whitespace where possible so the elision doesn't sit
  // mid-word.
  const head = trimToBoundary(text.slice(0, headBudget), "end");
  const tail = trimToBoundary(text.slice(text.length - tailBudget), "start");
  return `${head}\n\n…[${elidedChars.toLocaleString()} chars elided]\n\n${tail}`;
}

function trimToBoundary(slice: string, edge: "start" | "end"): string {
  // Look for a paragraph boundary first; fall back to a line break; fall
  // back to the raw slice if the file has no whitespace at all.
  if (edge === "end") {
    const para = slice.lastIndexOf("\n\n");
    if (para > slice.length / 2) return slice.slice(0, para);
    const line = slice.lastIndexOf("\n");
    if (line > slice.length / 2) return slice.slice(0, line);
    return slice;
  }
  const para = slice.indexOf("\n\n");
  if (para >= 0 && para < slice.length / 2) return slice.slice(para + 2);
  const line = slice.indexOf("\n");
  if (line >= 0 && line < slice.length / 2) return slice.slice(line + 1);
  return slice;
}
