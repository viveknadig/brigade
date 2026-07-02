#!/usr/bin/env node
// Regenerate the "🦁 Brigadiers" contributor wall in README.md from the LIVE
// GitHub contributors list, so it updates itself instead of drifting.
//
// Why not contrib.rocks? That's a single server-CACHED image — new contributors
// lag by hours/days and it can't be linked per-person. This writes committed
// avatar markdown between the `<!-- brigadiers:start -->` / `<!-- brigadiers:end -->`
// markers (like OpenClaw's committed table), so it renders instantly with no CDN
// cache and each avatar links to the person. Run by .github/workflows/brigadiers.yml
// on every merge to main + weekly; it commits ONLY when the wall actually changes.
//
// Self-contained: built-in fetch, zero dependencies (no new supply-chain surface).
//
// Usage:
//   node scripts/update-brigadiers.mjs          # rewrite README.md in place
//   node scripts/update-brigadiers.mjs --check   # exit 1 if it WOULD change (CI drift check)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = process.env.BRIGADIERS_REPO || "spinabot/brigade";
const COLUMNS = 12;
const START = "<!-- brigadiers:start -->";
const END = "<!-- brigadiers:end -->";
const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md");

async function fetchContributors() {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "brigade-brigadiers",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	// A token lifts the rate limit + is required for the workflow's authed calls;
	// unauthenticated works too (fine for a single occasional run).
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
	// Drop bots (github-actions, dependabot, …). The API already returns humans
	// sorted by contribution count, so the wall leads with the most active.
	return all.filter((c) => c && c.type !== "Bot" && !String(c.login).endsWith("[bot]"));
}

function renderWall(contributors) {
	if (contributors.length === 0) {
		return "_Be the first — see [CONTRIBUTING.md](CONTRIBUTING.md)._";
	}
	const cell = (c) =>
		`[![${c.login}](https://avatars.githubusercontent.com/u/${c.id}?v=4&s=48)](https://github.com/${c.login})`;
	const rows = [];
	for (let i = 0; i < contributors.length; i += COLUMNS) {
		rows.push(contributors.slice(i, i + COLUMNS).map(cell).join(" "));
	}
	return rows.join("\n\n");
}

function splice(readme, wall) {
	const s = readme.indexOf(START);
	const e = readme.indexOf(END);
	if (s === -1 || e === -1 || e < s) {
		throw new Error(
			`README markers not found — add a block:\n${START}\n${END}\nwhere the wall should render.`,
		);
	}
	return `${readme.slice(0, s + START.length)}\n\n${wall}\n\n${readme.slice(e)}`;
}

const check = process.argv.includes("--check");
const readme = await readFile(README, "utf8");
const contributors = await fetchContributors();
const next = splice(readme, renderWall(contributors));

if (next === readme) {
	console.log(`Brigadiers wall already current (${contributors.length} contributors).`);
	process.exit(0);
}
if (check) {
	console.error("Brigadiers wall is stale — run: node scripts/update-brigadiers.mjs");
	process.exit(1);
}
await writeFile(README, next, "utf8");
console.log(`Updated Brigadiers wall (${contributors.length} contributors).`);
