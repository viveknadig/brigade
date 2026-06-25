/**
 * Convert agent-style markdown (Brigade agents output this by default) into
 * Discord's message markup.
 *
 * Discord renders a near-CommonMark dialect natively, so — unlike Slack's
 * `mrkdwn` (single-asterisk bold) or Telegram's strict HTML — most agent
 * markdown passes through UNCHANGED:
 *   - **bold** / __underline__   → kept (Discord: `**bold**`, `__underline__`)
 *   - *italic* / _italic_        → kept
 *   - ~~strike~~                 → kept
 *   - `code`                     → kept (interior verbatim)
 *   - ```fenced```               → kept (interior verbatim, language tag kept)
 *   - > quote                    → kept
 *   - `-`/`*`/`+` bullets        → kept
 *   - 1. numbered lists          → kept
 *   - # headings                 → kept (Discord renders `#`/`##`/`###` headers)
 *
 * The ONE load-bearing transform: a markdown link `[label](url)` renders
 * LITERALLY in a normal Discord message (Discord only auto-links bare URLs and
 * honours `[label](url)` in embeds, not plain content). So a plain-message link
 * is rewritten to `label (url)` — the same readable fallback Slack/Telegram use
 * when a link can't be a native token. A bare URL is left as-is (Discord
 * auto-links it).
 *
 * MENTION PASSTHROUGH (critical): an agent that authored a Discord mention token
 * means it to PING. Discord's tokens are `<@123>` (user), `<@!123>` (member
 * nickname), `<@&123>` (role), `<#123>` (channel), `<:name:123>` / `<a:name:123>`
 * (custom / animated emoji), and the literal `@everyone` / `@here`. Those are
 * passed through VERBATIM so the mention actually resolves; everything else is
 * left as Discord-native markdown. We do NOT entity-escape (Discord has no HTML
 * entities) — we only neutralize a STRAY markdown link.
 *
 * Pure / deterministic — no I/O, no globals. Models the SHAPE of
 * `slack/format.ts` (markdown in → channel-native formatting out) but emits
 * Discord markup.
 */

/** Discord's hard per-message content limit (chars). Sends chunk under this. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * A pre-formed Discord token that must pass through verbatim so it resolves:
 *   - `<@123>` / `<@!123>`  user / member mention
 *   - `<@&123>`             role mention
 *   - `<#123>`              channel mention
 *   - `<:name:123>` / `<a:name:123>`  custom / animated emoji
 *   - `<t:123>` / `<t:123:R>`         timestamp
 * Anchored at the `<` the scanner is sitting on. Returns the matched token
 * length, or 0 when the `<…>` isn't a recognised Discord token.
 */
function matchDiscordToken(text: string, start: number): number {
	// Find the closing `>` for this `<`.
	const close = text.indexOf(">", start + 1);
	if (close === -1) return 0;
	const inner = text.slice(start + 1, close);
	// user / member: @123 or @!123 ; role: @&123 ; channel: #123
	if (/^@!?\d+$/.test(inner)) return close - start + 1;
	if (/^@&\d+$/.test(inner)) return close - start + 1;
	if (/^#\d+$/.test(inner)) return close - start + 1;
	// custom / animated emoji: :name:123 or a:name:123
	if (/^a?:[A-Za-z0-9_]{2,32}:\d+$/.test(inner)) return close - start + 1;
	// timestamp: t:123 or t:123:R
	if (/^t:\d+(?::[tTdDfFR])?$/.test(inner)) return close - start + 1;
	return 0;
}

/** Try to match a `[label](url)` link starting at `start` (the `[`). */
function matchMarkdownLink(text: string, start: number): { label: string; url: string; end: number } | null {
	const labelEnd = text.indexOf("]", start + 1);
	if (labelEnd === -1) return null;
	if (text[labelEnd + 1] !== "(") return null;
	// Balanced-paren scan from just after the opening `(` so a URL that itself
	// contains parentheses (e.g. `…/Mercury_(planet)`) keeps its closing `)`. A
	// plain `indexOf(")")` would truncate at the FIRST `)`, dropping the rest.
	let depth = 1;
	let urlEnd = -1;
	for (let j = labelEnd + 2; j < text.length; j++) {
		const c = text[j];
		if (c === "(") depth += 1;
		else if (c === ")") {
			depth -= 1;
			if (depth === 0) {
				urlEnd = j;
				break;
			}
		}
	}
	if (urlEnd === -1) return null;
	const label = text.slice(start + 1, labelEnd);
	const url = text.slice(labelEnd + 2, urlEnd).trim();
	// Only honour http/https/mailto/tel links — anything else stays literal so we
	// never linkify a path / fragment that wasn't a real URL.
	if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return null;
	if (!label) return null;
	return { label, url, end: urlEnd + 1 };
}

/**
 * Render the INLINE span markup of one already-newline-free run into Discord
 * markup. Inline code is preserved verbatim (its interior is never rewritten),
 * Discord mention/emoji tokens pass through verbatim, and a markdown link is
 * rewritten to the readable `label (url)` fallback. Everything else is passed
 * through unchanged (Discord renders **bold** / *italic* / ~~strike~~ natively).
 */
function renderInlineSpans(text: string): string {
	const out: string[] = [];
	let i = 0;
	const n = text.length;

	while (i < n) {
		const ch = text[i];
		// Inline code: `…` — interior is verbatim (no link rewrite inside code).
		if (ch === "`") {
			// Support a run of backticks (`` `x` `` / ``` ``y`` ``` ) — match the
			// same-length closing fence so an interior backtick doesn't close early.
			const fenceMatch = /^`+/.exec(text.slice(i));
			const fence = fenceMatch ? fenceMatch[0] : "`";
			const close = text.indexOf(fence, i + fence.length);
			if (close !== -1) {
				out.push(text.slice(i, close + fence.length));
				i = close + fence.length;
				continue;
			}
		}
		// Pre-formed Discord token (mention / channel / role / emoji / timestamp) —
		// pass through verbatim so it actually resolves on Discord.
		if (ch === "<") {
			const len = matchDiscordToken(text, i);
			if (len > 0) {
				out.push(text.slice(i, i + len));
				i += len;
				continue;
			}
		}
		// Markdown link: [label](url) → "label (url)" (a plain Discord message
		// renders the markdown-link form literally, so we degrade to readable text).
		if (ch === "[") {
			const link = matchMarkdownLink(text, i);
			if (link) {
				// When the label already equals the url, just emit the bare url
				// (Discord auto-links it) to avoid the noisy "url (url)".
				out.push(link.label === link.url ? link.url : `${link.label} (${link.url})`);
				i = link.end;
				continue;
			}
		}
		out.push(ch ?? "");
		i += 1;
	}
	return out.join("");
}

/** Render a markdown pipe-table block as flat "cell | cell" lines. */
function renderTableBlock(block: string[]): string {
	const rows: string[] = [];
	for (const row of block) {
		// Drop the separator row (`| --- | :--: |`).
		if (/^\s*\|?[\s|:-]+\|?\s*$/.test(row)) continue;
		const cells = row
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		if (cells.length) rows.push(cells.map((c) => renderInlineSpans(c)).join(" | "));
	}
	return rows.join("\n");
}

/**
 * Convert agent-style markdown into Discord markup. Block structure (fenced code,
 * tables) is handled line-by-line so a link inside a code fence is never
 * rewritten; inline markup (links, mentions, code) is handled per-line by
 * {@link renderInlineSpans}. Headings / bullets / numbered lists / blockquotes
 * render natively on Discord, so they pass through with only their inline spans
 * rewritten.
 */
export function markdownToDiscord(markdown: string): string {
	if (!markdown) return "";
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	const n = lines.length;

	while (i < n) {
		const line = lines[i] ?? "";

		// Fenced code block: ```lang … ``` — kept VERBATIM (language tag + interior),
		// Discord renders it natively and a link inside must not be rewritten.
		const fenceOpen = /^\s*```/.exec(line);
		if (fenceOpen) {
			out.push(line);
			i += 1;
			while (i < n) {
				const inner = lines[i] ?? "";
				out.push(inner);
				i += 1;
				if (/^\s*```\s*$/.test(inner)) break;
			}
			continue;
		}

		// Pipe-table block: ≥2 contiguous lines that start+end with `|`. Discord has
		// no table rendering, so flatten to "cell | cell" lines (parity w/ Slack).
		if (/^\s*\|.*\|\s*$/.test(line)) {
			const start = i;
			while (i < n && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) i += 1;
			if (i - start >= 2) {
				out.push(renderTableBlock(lines.slice(start, i)));
				continue;
			}
			i = start;
		}

		// Plain / heading / bullet / quote line — render inline spans; the block
		// markers (`#`, `-`, `>`, `1.`) are left in place for Discord to render.
		out.push(renderInlineSpans(line));
		i += 1;
	}

	return out.join("\n");
}

/**
 * Code-span matcher: a fenced ```…``` block OR an inline `…` span. Used by
 * {@link rewriteKnownMentions} to SKIP rewriting handles that live inside code
 * (where an `@alex` is verbatim text, not a mention the author wants pinged).
 */
const CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * A plain `@handle` candidate OUTSIDE a code span. Group 1 is the preceding
 * boundary char (start-of-string or a separator) so we never match an `@` glued
 * to a word (an email's `@`, or a `<@id>` token's `@`); group 2 is the handle
 * body (Discord usernames: letters/digits/underscore/dot/hyphen, 2–32 chars,
 * with an optional legacy `#1234` discriminator).
 */
const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;

/** Discord resolves these itself — never rewrite them to a user token. */
const RESERVED_MENTIONS = new Set(["everyone", "here"]);

/**
 * Rewrite a plain `@handle` to its `<@id>` mention token — but ONLY when
 * `resolve(handle)` returns a known user id. An unknown handle stays literal
 * (we never invent a ping). Skips:
 *   - code spans / fenced blocks (an `@alex` there is verbatim, not a mention);
 *   - `@everyone` / `@here` (Discord-reserved, and `<@…>`-safe-mentions never
 *     parse "everyone" anyway);
 *   - a handle already sitting inside a `<@…>` token (the boundary group means
 *     the `@` after `<` is never a candidate start).
 *
 * Called by the adapter BEFORE `markdownToDiscord` so a freshly-minted `<@id>`
 * passes through the converter as a verbatim mention token. Pure over its
 * `resolve` argument — the resolver carries the account-scoped directory cache.
 */
export function rewriteKnownMentions(text: string, resolve: (handle: string) => string | undefined): string {
	if (!text || !text.includes("@")) return text;
	const rewriteOutsideCode = (segment: string): string =>
		segment.replace(MENTION_CANDIDATE_PATTERN, (match, boundary: string, handle: string) => {
			const lookup = handle.toLowerCase();
			if (RESERVED_MENTIONS.has(lookup.replace(/#[0-9]{4}$/, ""))) return match;
			const id = resolve(handle);
			if (!id || !/^\d+$/.test(id)) return match;
			return `${boundary}<@${id}>`;
		});
	// Walk the string, leaving every code segment untouched and rewriting the
	// gaps between them.
	let out = "";
	let offset = 0;
	CODE_SEGMENT_PATTERN.lastIndex = 0;
	for (const m of text.matchAll(CODE_SEGMENT_PATTERN)) {
		const idx = m.index ?? 0;
		out += rewriteOutsideCode(text.slice(offset, idx));
		out += m[0];
		offset = idx + m[0].length;
	}
	out += rewriteOutsideCode(text.slice(offset));
	return out;
}

/**
 * True when the rendered Discord text carries no visible content — only
 * whitespace and/or markdown markers. Discord rejects an empty message body, so
 * the send path falls back / skips when this returns true. Mirrors
 * `slackMrkdwnIsEmpty` intent.
 */
export function discordTextIsEmpty(text: string): boolean {
	if (!text) return true;
	const stripped = text
		// Mentions / channels / roles / emoji ARE content.
		.replace(/<a?:[A-Za-z0-9_]+:\d+>/g, "x")
		.replace(/<@[!&]?\d+>/g, "x")
		.replace(/<#\d+>/g, "x")
		.replace(/<t:\d+(?::[tTdDfFR])?>/g, "x")
		.replace(/[*_~`>#|.\-\s]/g, "")
		.trim();
	return stripped.length === 0;
}
