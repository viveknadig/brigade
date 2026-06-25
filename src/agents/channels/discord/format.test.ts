import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { discordTextIsEmpty, markdownToDiscord, rewriteKnownMentions, DISCORD_MESSAGE_LIMIT } from "./format.js";

describe("markdownToDiscord", () => {
	it("passes CommonMark emphasis through unchanged (Discord renders it natively)", () => {
		assert.equal(markdownToDiscord("hi **there**"), "hi **there**");
		assert.equal(markdownToDiscord("an *emphatic* word"), "an *emphatic* word");
		assert.equal(markdownToDiscord("an _emphatic_ word"), "an _emphatic_ word");
		assert.equal(markdownToDiscord("__underline__ vibes"), "__underline__ vibes");
		assert.equal(markdownToDiscord("~~gone~~"), "~~gone~~");
	});

	it("does NOT entity-escape <, >, & (Discord has no HTML entities)", () => {
		assert.equal(markdownToDiscord("a & b < c > d"), "a & b < c > d");
		assert.equal(markdownToDiscord("if x < 3 and y > 4"), "if x < 3 and y > 4");
	});

	it("rewrites [label](url) to the readable 'label (url)' fallback", () => {
		assert.equal(markdownToDiscord("see [docs](https://example.com/a?b=1&c=2)"), "see docs (https://example.com/a?b=1&c=2)");
	});

	it("keeps a closing paren inside a linkified URL (balanced-paren scan)", () => {
		assert.equal(
			markdownToDiscord("see [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))"),
			"see Mercury (https://en.wikipedia.org/wiki/Mercury_(planet))",
		);
	});

	it("emits just the bare url when label === url (avoids 'url (url)')", () => {
		assert.equal(markdownToDiscord("[https://e.com](https://e.com)"), "https://e.com");
	});

	it("leaves a non-http link literal (never linkifies a path)", () => {
		assert.equal(markdownToDiscord("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
		assert.equal(markdownToDiscord("see [readme](./README.md)"), "see [readme](./README.md)");
	});

	it("renders inline `code` verbatim with NO link rewrite inside", () => {
		assert.equal(markdownToDiscord("run `see [x](https://e.com)`"), "run `see [x](https://e.com)`");
	});

	it("supports multi-backtick inline code", () => {
		assert.equal(markdownToDiscord("``a`b``"), "``a`b``");
	});

	it("keeps a fenced block verbatim (language tag + interior, no link rewrite)", () => {
		const md = ["```ts", "const x = a < b; // [docs](https://e.com)", "```"].join("\n");
		assert.equal(markdownToDiscord(md), md);
	});

	it("keeps an unterminated fence with what it captured", () => {
		const md = ["```", "line one", "line two"].join("\n");
		assert.equal(markdownToDiscord(md), md);
	});

	it("passes pre-formed Discord mention tokens through verbatim so they ping", () => {
		assert.equal(markdownToDiscord("hi <@123>"), "hi <@123>");
		assert.equal(markdownToDiscord("hi <@!123>"), "hi <@!123>");
		assert.equal(markdownToDiscord("ping role <@&456>"), "ping role <@&456>");
		assert.equal(markdownToDiscord("see <#789>"), "see <#789>");
		assert.equal(markdownToDiscord("react <:partyblob:111>"), "react <:partyblob:111>");
		assert.equal(markdownToDiscord("react <a:spin:222>"), "react <a:spin:222>");
		assert.equal(markdownToDiscord("due <t:1700000000:R>"), "due <t:1700000000:R>");
	});

	it("leaves @everyone / @here literal (Discord resolves them itself)", () => {
		assert.equal(markdownToDiscord("@everyone heads up"), "@everyone heads up");
		assert.equal(markdownToDiscord("@here ping"), "@here ping");
	});

	it("leaves a non-token angle pair literal (comparison stays as typed)", () => {
		assert.equal(markdownToDiscord("a <not a token> b"), "a <not a token> b");
	});

	it("keeps headings / bullets / numbered lists / quotes as native markdown", () => {
		assert.equal(markdownToDiscord("# Title\nbody"), "# Title\nbody");
		assert.equal(markdownToDiscord("- one\n- two\n+ three"), "- one\n- two\n+ three");
		assert.equal(markdownToDiscord("1. first\n2. second"), "1. first\n2. second");
		assert.equal(markdownToDiscord("> quoted\n> more"), "> quoted\n> more");
	});

	it("rewrites links inside a bullet line but keeps the bullet marker", () => {
		assert.equal(markdownToDiscord("- see [docs](https://e.com)"), "- see docs (https://e.com)");
	});

	it("flattens a markdown table to pipe-joined rows (drops separator)", () => {
		const md = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
		assert.equal(markdownToDiscord(md), ["a | b", "1 | 2", "3 | 4"].join("\n"));
	});

	it("is a no-op on plain text + empty input", () => {
		assert.equal(markdownToDiscord("hello there"), "hello there");
		assert.equal(markdownToDiscord(""), "");
	});

	it("exposes the 2000-char Discord message limit", () => {
		assert.equal(DISCORD_MESSAGE_LIMIT, 2000);
	});
});

describe("rewriteKnownMentions (Fix 2a)", () => {
	// "alex" → snowflake "111" is the only remembered handle in these cases. A
	// resolved id MUST be a numeric snowflake (a real Discord mention requires one).
	const resolve = (handle: string): string | undefined => (handle.toLowerCase() === "alex" ? "111" : undefined);

	it("rewrites a known @handle to its <@id> token", () => {
		assert.equal(rewriteKnownMentions("ping @alex", resolve), "ping <@111>");
	});

	it("matches case-insensitively but emits the resolved id", () => {
		assert.equal(rewriteKnownMentions("ping @Alex now", resolve), "ping <@111> now");
	});

	it("leaves an UNKNOWN @handle literal (never invents a ping)", () => {
		assert.equal(rewriteKnownMentions("ping @bob", resolve), "ping @bob");
	});

	it("leaves a non-snowflake resolution literal (never emits a bad token)", () => {
		const badResolve = (): string | undefined => "not-a-snowflake";
		assert.equal(rewriteKnownMentions("ping @alex", badResolve), "ping @alex");
	});

	it("leaves @everyone / @here untouched even if a resolver would hit", () => {
		const hitAll = (): string | undefined => "999";
		assert.equal(rewriteKnownMentions("@everyone heads up", hitAll), "@everyone heads up");
		assert.equal(rewriteKnownMentions("@here ping", hitAll), "@here ping");
	});

	it("does NOT rewrite a @handle inside an inline `code` span", () => {
		assert.equal(rewriteKnownMentions("run `@alex` now", resolve), "run `@alex` now");
	});

	it("does NOT rewrite a @handle inside a fenced block", () => {
		const md = ["```", "@alex", "```"].join("\n");
		assert.equal(rewriteKnownMentions(md, resolve), md);
	});

	it("does NOT double-rewrite a handle already inside a <@…> token", () => {
		// The `@` after `<` has no boundary char before it, so it's never a candidate.
		assert.equal(rewriteKnownMentions("hi <@111>", resolve), "hi <@111>");
	});

	it("is a no-op when the text has no @", () => {
		assert.equal(rewriteKnownMentions("plain text", resolve), "plain text");
	});

	it("rewrites a handle at the very start of the string", () => {
		assert.equal(rewriteKnownMentions("@alex hi", resolve), "<@111> hi");
	});

	it("does not match an @ glued to a word (email-like)", () => {
		assert.equal(rewriteKnownMentions("mail me at x@alex.com", resolve), "mail me at x@alex.com");
	});

	it("end-to-end through markdownToDiscord: rewrite then convert keeps the token", () => {
		// The adapter rewrites BEFORE markdownToDiscord; the converter passes <@id> verbatim.
		assert.equal(markdownToDiscord(rewriteKnownMentions("ping @alex", resolve)), "ping <@111>");
	});
});

describe("discordTextIsEmpty", () => {
	it("is true for empty / whitespace-only / marker-only", () => {
		assert.equal(discordTextIsEmpty(""), true);
		assert.equal(discordTextIsEmpty("   \n  "), true);
		assert.equal(discordTextIsEmpty("** __ ~~ >"), true);
	});

	it("is false when there is visible content", () => {
		assert.equal(discordTextIsEmpty("**hi**"), false);
		assert.equal(discordTextIsEmpty("plain"), false);
	});

	it("treats a mention / emoji / channel as visible content", () => {
		assert.equal(discordTextIsEmpty("<@123>"), false);
		assert.equal(discordTextIsEmpty("<#456>"), false);
		assert.equal(discordTextIsEmpty("<:blob:789>"), false);
	});
});
