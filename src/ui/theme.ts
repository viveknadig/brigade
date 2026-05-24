/**
 * Shared Pi-TUI themes for Brigade.
 *
 * One canonical place so onboarding + chat feel like the same app.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";

import { syntaxTheme } from "./syntax-theme.js";

const CODE_FALLBACK = "#fde7c4";

/**
 * Detect compact JSON the model emitted on a single line and reformat
 * with 2-space indentation. Only fires when the lang tag is `json` AND
 * the body parses cleanly; everything else is passed through untouched.
 *
 * Why: gpt-class models often emit `{"a":1,"b":2}` even when the user
 * asked "show me a JSON object" — the structure is correct but reads
 * worse than multi-line in a chat UI. We catch the compact form at
 * render time so the rest of the pipeline stays unchanged.
 */
function maybePrettyPrintJson(code: string, lang?: string): string {
  if (lang !== "json" && lang !== "jsonc") return code;
  const trimmed = code.trim();
  if (trimmed.length === 0) return code;
  // Cheap shape check before paying for JSON.parse: must look like an
  // object or array. Avoids spurious parsing on bash output that
  // happens to have braces.
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return code;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return code;
  }
}

/**
 * Plug into Pi-TUI's `MarkdownTheme.highlightCode` slot. Pi-TUI calls
 * this for every fenced code block (` ```bash `, ` ```json `, etc.) and
 * applies the result line-by-line through `markdownTheme.codeBlock`.
 * Returning ANSI-coloured lines gives us syntax-highlighted blocks for
 * free without touching the markdown parser.
 *
 * Behaviour:
 *   - Known language → highlight with that grammar (e.g. `bash`, `json`).
 *   - JSON → pretty-printed across multiple lines before highlighting.
 *   - Unknown / missing tag → fall back to highlight.js auto-detect.
 *   - Auto-detect throws (illegal syntax / weird input) → return plain
 *     lines styled with the code-fallback colour so the block still looks
 *     like code, just unstyled.
 */
function highlightCode(code: string, lang?: string): string[] {
  const formatted = maybePrettyPrintJson(code, lang);
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const out = highlight(formatted, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return out.split("\n");
  } catch {
    return formatted.split("\n").map((line) => chalk.hex(CODE_FALLBACK)(line));
  }
}

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.hex("#fbbf24")(s), // amber
  link: (s) => chalk.hex("#60a5fa")(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.hex(CODE_FALLBACK)(s),
  codeBlock: (s) => chalk.hex("#a7f3d0")(s),
  codeBlockBorder: (s) => chalk.dim.hex("#92400e")(s),
  quote: (s) => chalk.italic.hex(CODE_FALLBACK)(s),
  quoteBorder: (s) => chalk.dim.hex("#92400e")(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.hex("#fbbf24")(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode,
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: {
    selectedPrefix: (s) => chalk.hex("#fbbf24")(s),
    selectedText: (s) => chalk.bold(s),
    description: (s) => chalk.dim(s),
    scrollInfo: (s) => chalk.dim(s),
    noMatch: (s) => chalk.dim(s),
  },
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.hex("#fbbf24")(s),
  selectedText: (s) => chalk.bold(s),
  description: (s) => chalk.dim(s),
  scrollInfo: (s) => chalk.dim(s),
  noMatch: (s) => chalk.dim("  No matching option"),
};

/** Brand color helpers (used for status bars, dividers, accents). */
export const brand = {
  amber: (s: string) => chalk.hex("#fbbf24")(s),
  amberDeep: (s: string) => chalk.hex("#92400e")(s),
  dim: (s: string) => chalk.dim(s),
  white: (s: string) => chalk.white(s),
  user: (s: string) => chalk.bold.hex("#60a5fa")(s),
  agent: (s: string) => chalk.bold.hex("#fbbf24")(s),
  tool: (s: string) => chalk.hex("#a7f3d0")(s),
  error: (s: string) => chalk.bold.hex("#fca5a5")(s),
};
