#!/usr/bin/env node
// Regenerate the "🦁 Brigadiers" contributor wall in README.md from the LIVE
// GitHub contributor graph, so it's INSTANT (a bot commits the fresh wall right
// after a PR merges) yet never hand-maintained.
//
// Why committed instead of a live contrib.rocks image? The image is server-cached
// (a new contributor lags ~a day) and can't link per-person. This writes uniform,
// crisp, linked avatars so the wall renders instantly and updates the moment
// someone contributes. Self-contained: built-in fetch, zero dependencies.
//
// Usage:
//   node scripts/update-brigadiers.mjs           # rewrite README.md in place
//   node scripts/update-brigadiers.mjs --check    # exit 1 if it WOULD change (CI drift check)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = process.env.BRIGADIERS_REPO || "spinabot/brigade";
// Format matches OpenClaw's committed wall byte-for-byte: markdown linked images
// at s=48, 10 per line (space-separated), rows separated by a blank line.
const AVATAR_SIZE = 48;
const PER_LINE = 10;
const START = "<!-- brigadiers:start -->";
const END = "<!-- brigadiers:end -->";
const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md");

async function fetchContributors() {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "brigade-brigadiers",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

	const all = [];
	for (let page = 1; page <= 20; page++) {
		const res = await fetch(
			`https://api.github.com/repos/${REPO}/contributors?per_page=100&page=${page}`,
			{ headers },
		);
		if (!res.ok) {
			throw new Error(`GitHub contributors API ${res.status}: ${await res.text().catch(() => "")}`);
		}
		const batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		all.push(...batch);
		if (batch.length < 100) break;
	}
	// Drop bots (github-actions, dependabot, …). The API already sorts humans by
	// contribution count, so the wall leads with the most active.
	return all.filter((c) => c && c.type !== "Bot" && !String(c.login).endsWith("[bot]"));
}

function renderWall(contributors) {
	if (contributors.length === 0) {
		return "_Be the first — see [CONTRIBUTING.md](CONTRIBUTING.md)._";
	}
	// EXACT OpenClaw format: markdown linked images `[![login](avatar?s=48)](profile)`,
	// PER_LINE per row (space-separated), rows separated by a blank line. Plain
	// markdown — no HTML — so it's byte-for-byte how OpenClaw commits its wall.
	const cell = (c) =>
		`[![${c.login}](https://avatars.githubusercontent.com/u/${c.id}?v=4&s=${AVATAR_SIZE})](https://github.com/${c.login})`;
	const lines = [];
	for (let i = 0; i < contributors.length; i += PER_LINE) {
		lines.push(contributors.slice(i, i + PER_LINE).map(cell).join(" "));
	}
	return lines.join("\n\n");
}

function splice(readme, wall) {
	const s = readme.indexOf(START);
	const e = readme.indexOf(END);
	if (s === -1 || e === -1 || e < s) {
		throw new Error(
			`README markers not found — add a block:\n${START}\n${END}\nwhere the wall should render.`,
		);
	}
	return `${readme.slice(0, s + START.length)}\n${wall}\n${readme.slice(e)}`;
}

const check = process.argv.includes("--check");
const readme = await readFile(README, "utf8");
const contributors = await fetchContributors();
const next = splice(readme, renderWall(contributors));

// Set process.exitCode and let the event loop drain naturally — never process.exit(),
// which force-tears-down the still-pooled fetch socket (a harmless-but-noisy libuv
// assertion on Windows).
if (next === readme) {
	console.log(`Brigadiers wall already current (${contributors.length} contributors).`);
} else if (check) {
	console.error("Brigadiers wall is stale — run: node scripts/update-brigadiers.mjs");
	process.exitCode = 1;
} else {
	await writeFile(README, next, "utf8");
	console.log(`Updated Brigadiers wall (${contributors.length} contributors).`);
}
