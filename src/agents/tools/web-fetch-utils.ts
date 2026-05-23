/**
 * HTML → markdown extraction utilities.
 *
 * Two-tier pipeline lifted from the upstream reference:
 *
 *   1. **Primary** — `extractReadableContent`: Mozilla Readability + linkedom
 *      (both lazy-loaded so the agent loop doesn't pay the parse cost on a
 *      cold start). Readability scores the DOM, picks the "article" node,
 *      and returns its inner HTML; we then hand-roll that to markdown via
 *      regex (NOT Turndown — Turndown is heavy + opinionated, the regex
 *      pipeline below is ~80 LOC and good-enough for the LLM consumer).
 *
 *   2. **Fallback** — `extractBasicHtmlContent`: pure-regex visible-text
 *      extraction used when Readability returns nothing (very-small pages,
 *      single-page apps with no semantic markup, malformed HTML).
 *
 * `sanitizeHtml` runs BEFORE either extractor to strip hidden content,
 * scripts/styles, and invisible-Unicode prompt-injection vectors. The
 * sanitizer is the single most load-bearing thing in this file — without it
 * an attacker page can hide instructions inside `<div hidden>...</div>` or
 * style-hidden divs and the markdown converter would surface them.
 */

import { truncateText } from "./web-shared.js";

/* ─────────────────────────── lazy deps ─────────────────────────── */

/**
 * The shape Readability needs from a parsed document — basically any
 * `linkedom`/`jsdom` Document. We type it permissively so the lazy load
 * doesn't pull DOM type definitions into the build.
 */
type DocumentLike = object;

interface ReadabilityModule {
	Readability: new (
		doc: DocumentLike,
		options?: { charThreshold?: number; classesToPreserve?: string[]; keepClasses?: boolean },
	) => {
		parse(): { title?: string | null; content?: string | null; textContent?: string | null } | null;
	};
}
interface LinkedomModule {
	parseHTML: (html: string) => { document: DocumentLike };
}

let readabilityP: Promise<ReadabilityModule> | null = null;
let linkedomP: Promise<LinkedomModule> | null = null;

async function loadReadability(): Promise<ReadabilityModule> {
	if (!readabilityP) {
		readabilityP = (import("@mozilla/readability") as unknown as Promise<ReadabilityModule>).catch(
			(err) => {
				readabilityP = null;
				throw err;
			},
		);
	}
	return readabilityP;
}

async function loadLinkedom(): Promise<LinkedomModule> {
	if (!linkedomP) {
		linkedomP = (import("linkedom") as unknown as Promise<LinkedomModule>).catch((err) => {
			linkedomP = null;
			throw err;
		});
	}
	return linkedomP;
}

/* ─────────────────────────── sanitizer ─────────────────────────── */

/** Tags that get fully removed before extraction (content + all). */
const STRIPPABLE_TAGS = [
	"script",
	"style",
	"noscript",
	"iframe",
	"object",
	"embed",
	"canvas",
	"svg",
	"template",
	"meta",
	"link",
];

/**
 * Class names that signal screen-reader-only / visually-hidden content.
 * Matched substring-wise on the class attribute so `sr-only my-class` hits.
 */
const HIDDEN_CLASS_HINTS = [
	"sr-only",
	"visually-hidden",
	"visuallyhidden",
	"screen-reader-only",
	"screen-reader-text",
	"hidden-text",
];

/**
 * Pre-extraction sanitizer. Strips:
 *   1. `<script>/<style>/<noscript>/<iframe>/<object>/<embed>/<canvas>/<svg>/<template>/<meta>/<link>` (tag + contents)
 *   2. HTML comments
 *   3. `<input type="hidden">`
 *   4. Elements with `hidden` attribute, `aria-hidden="true"`, or inline-style
 *      hidden patterns (`display:none`, `visibility:hidden`, `opacity:0`,
 *      `font-size:0`, `text-indent:-9999px`, `clip-path: inset(50%)`,
 *      `transform: scale(0)`, off-screen positioning)
 *   5. Elements with `class*="sr-only"` / `visually-hidden` etc.
 *   6. Invisible-Unicode codepoints in the final text (zero-width joiners,
 *      RTL overrides, tag-namespace characters) — defends against
 *      prompt-injection-via-glyph-substitution.
 *
 * Pure regex — no DOM parsing. Fast (one pass per pattern), no allocations
 * beyond the working string. Some edge cases (e.g. self-closing tags
 * inside attributes) aren't covered; the linkedom-backed extractor handles
 * those because it's a real parser, and the sanitizer is "good enough"
 * for the basic-HTML fallback path.
 */
export function sanitizeHtml(html: string): string {
	let out = html;
	// Strip tag-blocks (open + body + close).
	for (const tag of STRIPPABLE_TAGS) {
		const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
		out = out.replace(re, "");
		// Self-closing variants.
		const selfRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
		out = out.replace(selfRe, "");
	}
	// Strip HTML comments — including ones spanning multiple lines.
	out = out.replace(/<!--[\s\S]*?-->/g, "");
	// Strip <input type="hidden" …>.
	out = out.replace(/<input\b[^>]*type=["']hidden["'][^>]*>/gi, "");
	// Strip elements with hidden / aria-hidden / hidden-class / hidden-style.
	out = stripHiddenByAttribute(out, "hidden");
	out = stripHiddenByAttribute(out, "aria-hidden", "true");
	out = stripHiddenByClass(out);
	out = stripHiddenByInlineStyle(out);
	return out;
}

/** Drop elements where attribute `attrName` is present (optionally with `value`). */
function stripHiddenByAttribute(html: string, attrName: string, value?: string): string {
	// Matches <tag … attrName=…>…</tag> (loose; doesn't recurse into nested same-tag).
	const valPart = value ? `=["']${value}["']` : `(?:=["'][^"']*["'])?`;
	const re = new RegExp(
		`<([a-z][a-z0-9-]*)\\b[^>]*\\b${attrName}\\b${valPart}[^>]*>[\\s\\S]*?<\\/\\1>`,
		"gi",
	);
	return html.replace(re, "");
}

/** Drop elements whose class attribute matches one of the hidden-class hints. */
function stripHiddenByClass(html: string): string {
	const hintRe = HIDDEN_CLASS_HINTS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const re = new RegExp(
		`<([a-z][a-z0-9-]*)\\b[^>]*class=["'][^"']*\\b(?:${hintRe})\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
		"gi",
	);
	return html.replace(re, "");
}

/** Drop elements whose inline `style` looks hidden. */
function stripHiddenByInlineStyle(html: string): string {
	const hiddenStyleHints = [
		/display\s*:\s*none/i,
		/visibility\s*:\s*hidden/i,
		/opacity\s*:\s*0(?:\.0+)?(?:[^.\d]|$)/i,
		/font-size\s*:\s*0(?:px|em|%)?(?:[^.\d]|$)/i,
		/text-indent\s*:\s*-?\d{4,}px/i,
		/clip-path\s*:\s*inset\(\s*50%/i,
		/transform\s*:\s*scale\(\s*0\b/i,
		/(?:left|top)\s*:\s*-\d{4,}px/i,
	];
	const re = /<([a-z][a-z0-9-]*)\b[^>]*style=["']([^"']*)["'][^>]*>[\s\S]*?<\/\1>/gi;
	return html.replace(re, (match, _tag, style: string) => {
		return hiddenStyleHints.some((h) => h.test(style)) ? "" : match;
	});
}

/**
 * Remove invisible Unicode codepoints from final text — zero-width joiners,
 * RTL/LTR overrides, tag-namespace characters. Hostile pages use these to
 * smuggle instructions into seemingly-innocent prose. Apply to the FINAL
 * markdown output, not the raw HTML (the HTML legitimately may contain
 * &#8203;-style entities that decode to invisible chars).
 */
export function stripInvisibleUnicode(text: string): string {
	// Build the regex from numeric ranges at runtime — avoids any chance
	// of literal-codepoint regex classes being mangled by editor encoding.
	// Covers (in order): zero-width space + joiner + non-joiner + RTL/LTR
	// marks (U+200B..U+200F); embedding/pop/override (U+202A..U+202E);
	// word joiner + invisible-math operators + function-application
	// (U+2060..U+2065); isolate marks (U+2066..U+2069); deprecated
	// inhibit/activate-formatting (U+206A..U+206F); BOM (U+FEFF);
	// tag-namespace characters used in invisible-tag attacks
	// (U+E0000..U+E007F). All ranges close on the visible end of common
	// prompt-injection-via-glyph attacks.
	const bmpRanges: ReadonlyArray<readonly [number, number]> = [
		[0x200B, 0x200F],
		[0x202A, 0x202E],
		[0x2060, 0x2065],
		[0x2066, 0x2069],
		[0x206A, 0x206F],
		[0xFEFF, 0xFEFF],
	];
	const out: string[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		let drop = false;
		for (const range of bmpRanges) {
			if (code >= range[0] && code <= range[1]) { drop = true; break; }
		}
		if (!drop && code >= 0xE0000 && code <= 0xE007F) drop = true;
		if (!drop) out.push(ch);
	}
	return out.join("");
}

/**
 * Scrub literal envelope marker tokens from incoming content. If an
 * attacker page emits the exact open/close markers used by
 * `wrapWebContent` (e.g. `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>`)
 * inside its own body, it can pose as a marker boundary and trick the
 * model into treating subsequent text as instructions. Replace any
 * occurrence with a placeholder before the envelope is applied.
 */
export function stripEnvelopeMarkers(text: string): string {
	return text
		.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>/gi, "[redacted-marker]")
		.replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>/gi, "[redacted-marker]");
}

/* ─────────────────────────── html → markdown ─────────────────────────── */

/**
 * Hand-rolled HTML→markdown via regex. NOT Turndown — Turndown is ~120 KB
 * + opinions we don't need. This converter handles the ~12 tags that
 * actually matter for LLM consumption (headings, paragraphs, links,
 * lists, code, blockquotes, emphasis) and stuffs the rest as plain text.
 *
 * Input is expected to be ALREADY sanitized (no `<script>`/`<style>`).
 */
export function htmlToMarkdown(html: string): string {
	let out = html;
	// Decode common HTML entities to their text equivalent.
	out = decodeHtmlEntities(out);
	// Headings — h1 → #, h2 → ##, …, h6 → ######.
	for (let i = 6; i >= 1; i -= 1) {
		const hashes = "#".repeat(i);
		const re = new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)<\\/h${i}>`, "gi");
		out = out.replace(re, (_m, body: string) => `\n\n${hashes} ${stripTags(body).trim()}\n\n`);
	}
	// Code blocks — `<pre><code>…</code></pre>` → fenced block.
	out = out.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, body: string) => {
		return `\n\n\`\`\`\n${decodeHtmlEntities(body).trim()}\n\`\`\`\n\n`;
	});
	// Inline code.
	out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => {
		return `\`${decodeHtmlEntities(body).replace(/\s+/g, " ").trim()}\``;
	});
	// Blockquotes.
	out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body: string) => {
		const inner = stripTags(body).trim();
		return `\n\n${inner
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")}\n\n`;
	});
	// Anchors — `<a href="x">y</a>` → `[y](x)`. Skip empty hrefs.
	out = out.replace(
		/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href: string, body: string) => {
			const label = stripTags(body).trim();
			if (!label) return "";
			if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return label;
			return `[${label}](${href})`;
		},
	);
	// Images — `<img alt="x" src="y">` → `![x](y)`. Drop entirely when src missing.
	out = out.replace(/<img\b[^>]*>/gi, (m: string) => {
		const srcMatch = m.match(/\bsrc=["']([^"']+)["']/i);
		if (!srcMatch) return "";
		const src = srcMatch[1] as string;
		const altMatch = m.match(/\balt=["']([^"']*)["']/i);
		const alt = altMatch ? (altMatch[1] as string) : "";
		return `![${alt}](${src})`;
	});
	// Lists. Convert `<li>` → `- ` then drop the surrounding `<ul>/<ol>`.
	out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body: string) => `\n- ${stripTags(body).trim()}`);
	out = out.replace(/<\/?(ul|ol)\b[^>]*>/gi, "");
	// Emphasis + strong + bold + italic.
	out = out.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, body: string) => `**${stripTags(body)}**`);
	out = out.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, body: string) => `*${stripTags(body)}*`);
	// Line break + horizontal rule.
	out = out.replace(/<br\s*\/?>/gi, "\n");
	out = out.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
	// Paragraph + div boundaries → double newline.
	out = out.replace(/<\/p\s*>/gi, "\n\n");
	out = out.replace(/<\/div\s*>/gi, "\n");
	// Strip everything else.
	out = stripTags(out);
	// Normalize whitespace.
	out = normalizeWhitespace(out);
	// Strip invisible Unicode (prompt-injection defense).
	out = stripInvisibleUnicode(out);
	// Scrub envelope markers — a poisoned page can't pose as the boundary.
	out = stripEnvelopeMarkers(out);
	return out.trim();
}

/** Strip ALL remaining HTML tags from a string. */
function stripTags(input: string): string {
	return input.replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, "");
}

/** Collapse runs of whitespace; keep paragraph breaks (double newlines). */
function normalizeWhitespace(input: string): string {
	return input
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]*\n[ \t]*/g, "\n");
}

/**
 * Decode the most common HTML entities. Not exhaustive — covers what
 * actually appears in scraped pages 99% of the time.
 */
export function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

/* ─────────────────────────── extractors ─────────────────────────── */

export interface ExtractedContent {
	title?: string;
	text: string;
	extractor: "readability" | "basic-html" | "raw-html" | "json" | "raw" | "cf-markdown";
}

/**
 * Run Mozilla Readability on an HTML doc. Returns null when Readability
 * gave us nothing useful (rare — Readability is forgiving). Caller should
 * fall back to `extractBasicHtmlContent` on null.
 */
export async function extractReadableContent(
	html: string,
	baseUrl: string,
): Promise<ExtractedContent | null> {
	// Sanitize first — Readability would otherwise score hidden-style spam
	// as real content.
	const sanitized = sanitizeHtml(html);
	// Pre-flight: very-deep DOMs blow Readability's recursion stack.
	if (sanitized.length > 1_048_576) return null;
	let parseHTML: LinkedomModule["parseHTML"];
	let Readability: ReadabilityModule["Readability"];
	try {
		const linkedom = await loadLinkedom();
		parseHTML = linkedom.parseHTML;
		const readability = await loadReadability();
		Readability = readability.Readability;
	} catch {
		// Lazy load failed — fall through; caller uses basic-html fallback.
		return null;
	}
	let doc: DocumentLike;
	try {
		const result = parseHTML(sanitized);
		doc = result.document;
		// Set baseURI so relative <a href> targets resolve correctly.
		try {
			Object.defineProperty(doc, "baseURI", { value: baseUrl, configurable: true });
		} catch {
			/* base-uri may be read-only in some linkedom versions */
		}
	} catch {
		return null;
	}
	const parsed = (() => {
		try {
			// charThreshold:0 — accept short articles (FAQs, landing pages,
			// docs). Default 500 would drop them to the regex fallback for no
			// benefit. classesToPreserve empty + keepClasses:false → keep
			// markup clean.
			return new Readability(doc, { charThreshold: 0, classesToPreserve: [], keepClasses: false }).parse();
		} catch {
			return null;
		}
	})();
	if (!parsed?.content) return null;
	const markdown = htmlToMarkdown(parsed.content);
	if (!markdown.trim()) return null;
	const rawTitle = parsed.title?.trim();
	const title = rawTitle ? stripEnvelopeMarkers(stripInvisibleUnicode(rawTitle)) : undefined;
	return {
		title: title || undefined,
		text: markdown,
		extractor: "readability",
	};
}

/**
 * Pure-regex fallback when Readability returns nothing. Strips all HTML and
 * returns the visible text. Loses structure (no headings, no lists), but
 * better than returning nothing — for small/SPA pages this is what the
 * model gets.
 */
export function extractBasicHtmlContent(html: string): ExtractedContent {
	const sanitized = sanitizeHtml(html);
	const titleMatch = sanitized.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const rawTitle = titleMatch
		? decodeHtmlEntities(stripTags(titleMatch[1] as string)).trim()
		: undefined;
	const title = rawTitle ? stripEnvelopeMarkers(stripInvisibleUnicode(rawTitle)) : undefined;
	const text = stripEnvelopeMarkers(
		stripInvisibleUnicode(normalizeWhitespace(decodeHtmlEntities(stripTags(sanitized)))),
	).trim();
	return { title: title || undefined, text, extractor: "basic-html" };
}

/** Strip markdown back to plain text (for the `extractMode: "text"` path). */
export function markdownToText(md: string): string {
	let out = md;
	// Fenced code blocks → keep body, drop fences.
	out = out.replace(/```[\s\S]*?```/g, (m: string) => m.replace(/^```.*\n?/, "").replace(/```$/, ""));
	// Inline code → keep body.
	out = out.replace(/`([^`]+)`/g, "$1");
	// Links → keep label.
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	// Images → keep alt.
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	// Headings, blockquotes, list markers.
	out = out.replace(/^#{1,6}\s+/gm, "").replace(/^>\s?/gm, "").replace(/^\s*[-*]\s+/gm, "");
	// Emphasis.
	out = out.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
	// Horizontal rules.
	out = out.replace(/^---+\s*$/gm, "");
	return normalizeWhitespace(out).trim();
}

/** Format text+title into a `truncateText`-able body. */
export function composeFetchBody(extracted: ExtractedContent, opts: { extractMode: "markdown" | "text"; maxChars: number }): {
	text: string;
	truncated: boolean;
} {
	const body = opts.extractMode === "text" ? markdownToText(extracted.text) : extracted.text;
	const withTitle = extracted.title ? `# ${extracted.title}\n\n${body}` : body;
	return truncateText(withTitle, opts.maxChars);
}
