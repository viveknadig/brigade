#!/usr/bin/env node
/**
 * Rebrand the vendored OAuth callback page with Brigade's mascot + favicon.
 *
 * After a browser sign-in (Claude Pro/Max, ChatGPT, GitHub Copilot), the SDK's
 * loopback server serves a small "you can close this window" page that ships with
 * the SDK's own logo + a generic title. This rewrites that one page so the browser
 * shows Brigade's lion mascot (large, with a soft gold glow), favicon, and tab
 * title — the consent screen itself is the provider's (e.g. "Claude Code") and is
 * left untouched.
 *
 * The brand assets ship beside this script (scripts/assets/) and are inlined as
 * data URIs, so a published `npm i -g @spinabot/brigade` brands the page with no
 * external files. Runs as a postinstall hook. Fully DEFENSIVE + idempotent: never
 * throws, never fails an install, re-applies cleanly if the assets change (the
 * size/glow is a marker-delimited <style> override, so it's robust to prior runs),
 * and no-ops if the upstream page shape ever changes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "BRIGADE_OAUTH_BRANDED";
const here = dirname(fileURLToPath(import.meta.url));

function dataUri(file, mime) {
	try {
		return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
	} catch {
		return null;
	}
}

try {
	// Resolve the SDK callback page via the "./oauth" export (ESM-only package;
	// ./package.json isn't exported). The page sits beside it.
	let oauthEntry;
	try {
		oauthEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/oauth"));
	} catch {
		process.exit(0);
	}
	const pagePath = join(dirname(oauthEntry), "utils", "oauth", "oauth-page.js");
	if (!existsSync(pagePath)) process.exit(0);

	const logoUri = dataUri(join(here, "assets", "brigade-logo.webp"), "image/webp");
	const faviconUri = dataUri(join(here, "assets", "brigade-favicon.ico"), "image/x-icon");
	if (!logoUri) process.exit(0);

	const before = readFileSync(pagePath, "utf8");
	// Strip any prior Brigade marker so a re-brand (e.g. after an asset swap) is clean.
	let out = before.replace(/^\/\/ BRIGADE_OAUTH_BRANDED[^\n]*\n/, "");

	// 1) Logo → the Brigade lion (cropped, transparent WebP).
	const logoImg = `<img src="${logoUri}" alt="Brigade" />`;
	out = out.replace(/const LOGO_SVG = `[\s\S]*?`;/, () => "const LOGO_SVG = `" + logoImg + "`;");

	// 2) Brand style override (marker-delimited → replace-or-insert, idempotent).
	//    Sizes the mascot large + adds a soft gold glow; overrides the 72px box.
	const brandStyle =
		`<style data-brigade-brand>` +
		`.logo{width:auto;height:auto;margin:0 auto 28px;display:flex;justify-content:center}` +
		`.logo img{height:300px;width:auto;max-width:82vw;display:block;filter:drop-shadow(0 14px 34px rgba(251,191,36,.16))}` +
		`</style>`;
	if (/<style data-brigade-brand>[\s\S]*?<\/style>/.test(out)) {
		out = out.replace(/<style data-brigade-brand>[\s\S]*?<\/style>/, () => brandStyle);
	} else if (out.includes("</head>")) {
		out = out.replace("</head>", () => "  " + brandStyle + "\n</head>");
	}

	// 3) Browser-tab title → "Brigade".
	out = out.replace("<title>${title}</title>", "<title>Brigade</title>");

	// 4) Favicon → Brigade's .ico (replace an existing icon link, else insert).
	if (faviconUri) {
		const faviconLink = `<link rel="icon" href="${faviconUri}" />`;
		if (/<link rel="icon"[^>]*\/>/.test(out)) {
			out = out.replace(/<link rel="icon"[^>]*\/>/, () => faviconLink);
		} else {
			const vp = `<meta name="viewport" content="width=device-width, initial-scale=1" />`;
			if (out.includes(vp)) out = out.replace(vp, () => vp + "\n  " + faviconLink);
		}
	}

	out = `// ${MARKER} — Brigade rebrands the SDK's OAuth callback page (scripts/brand-oauth-page.mjs).\n` + out;
	if (out === before) process.exit(0); // already fully branded — nothing to do
	writeFileSync(pagePath, out, "utf8");
	console.log("Brigade: branded the sign-in callback page.");
} catch {
	// A cosmetic patch must never break an install.
	process.exit(0);
}
