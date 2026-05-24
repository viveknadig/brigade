/**
 * Syntax-highlight theme for fenced code blocks in the TUI.
 *
 * Wired through `cli-highlight` (a wrapper around highlight.js) — Brigade's
 * `markdownTheme.highlightCode` hook hands the fenced source + language tag
 * to `highlight()`, gets back ANSI-coloured output, and Pi-TUI's Markdown
 * renderer applies the block-level styling (border, indent) around it.
 *
 * Token palette tuned for an amber-on-dark Brigade brand: same VS Code-ish
 * hues common to most syntax themes (purple keywords, teal built-ins,
 * orange strings, green comments) so the agent's output looks like
 * something you'd see in a normal editor while still feeling Brigade-y.
 *
 * Fallback colour = the brand's `code` orange. Pi-TUI's `markdownTheme.code`
 * already uses this; the syntax theme defaults to it so a `cli-highlight`
 * library miss (illegal syntax / unknown language) still renders in a
 * cohesive palette instead of stark white.
 */

import chalk from "chalk";
import type { Theme } from "cli-highlight";

const BRAND_CODE_ORANGE = "#F0C987";

/**
 * Token → ANSI styler map consumed by `cli-highlight`. Highlight.js
 * emits class names like `keyword`, `string`, `function` for each parsed
 * span; we map each to a `chalk.hex(...)` formatter that wraps the text
 * in the right SGR sequence.
 *
 * The token list mirrors highlight.js's CSS class names — additions or
 * tweaks just add a key here without touching any plumbing.
 */
export const syntaxTheme: Theme = {
	keyword: chalk.hex("#C586C0"),
	"selector-tag": chalk.hex("#C586C0"),
	literal: chalk.hex("#569CD6"),
	doctag: chalk.hex("#569CD6"),
	title: chalk.bold.hex("#DCDCAA"),
	section: chalk.bold.hex("#4EC9B0"),
	type: chalk.hex("#4EC9B0"),
	class: chalk.hex("#4EC9B0"),
	function: chalk.hex("#DCDCAA"),
	built_in: chalk.hex("#4EC9B0"),
	"builtin-name": chalk.hex("#4EC9B0"),
	number: chalk.hex("#B5CEA8"),
	string: chalk.hex("#CE9178"),
	regexp: chalk.hex("#D16969"),
	tag: chalk.hex("#569CD6"),
	"selector-id": chalk.hex("#D7BA7D"),
	"selector-class": chalk.hex("#D7BA7D"),
	"selector-attr": chalk.hex("#D7BA7D"),
	"selector-pseudo": chalk.hex("#D7BA7D"),
	attr: chalk.hex("#9CDCFE"),
	attribute: chalk.hex("#9CDCFE"),
	name: chalk.hex("#9CDCFE"),
	variable: chalk.hex("#9CDCFE"),
	"template-variable": chalk.hex("#9CDCFE"),
	"template-tag": chalk.hex("#569CD6"),
	params: chalk.hex("#9CDCFE"),
	symbol: chalk.hex("#9CDCFE"),
	subst: chalk.hex("#9CDCFE"),
	"meta-string": chalk.hex("#CE9178"),
	meta: chalk.hex("#9B9B9B"),
	"meta-keyword": chalk.hex("#C586C0"),
	comment: chalk.italic.hex("#6A9955"),
	quote: chalk.italic.hex("#6A9955"),
	deletion: chalk.bgHex("#3F1F1F").hex("#F97066"),
	addition: chalk.bgHex("#1F2D23").hex("#7DD3A5"),
	emphasis: chalk.italic,
	strong: chalk.bold,
	bullet: chalk.hex("#FBBF24"),
	link: chalk.hex("#60A5FA"),
	default: chalk.hex(BRAND_CODE_ORANGE),
};
