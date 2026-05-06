#!/usr/bin/env node
// Brigade entry shim — keeps the bin file tiny and lets src/entry.ts do the
// actual work. Two responsibilities live here intentionally:
//   1. Reject unsupported Node versions before anything else loads. Pi SDK
//      uses `using`/`AsyncDisposable` and other 22.12+ features, and Node
//      18/20 will fail with a confusing SyntaxError far from the cause.
//   2. Pick between a built dist/entry.js and an in-tree src/entry.ts so
//      `npm run dev` (no build step) and `npm run brigade` (built) both work.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const MIN_NODE = { major: 22, minor: 12 };

function ensureSupportedNodeVersion() {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!m) return;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (
    major > MIN_NODE.major ||
    (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  ) {
    return;
  }
  console.error(
    `brigade requires Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer ` +
      `(running ${process.versions.node}).`,
  );
  console.error(
    `If you're on nvm: \`nvm install ${MIN_NODE.major}\` then \`nvm use ${MIN_NODE.major}\`.`,
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

// Node's compile cache trims warm-start latency for the CLI. Enable it as
// early as possible — entry.ts re-enables defensively in case this shim is
// bypassed (e.g. when running via `tsx src/entry.ts`).
try {
  const mod = await import("node:module");
  if (typeof mod.enableCompileCache === "function") {
    mod.enableCompileCache();
  }
} catch {
  // Older Node minors silently skip — not fatal.
}

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "dist", "entry.js");
const srcEntry = join(here, "src", "entry.ts");

if (existsSync(distEntry)) {
  // Dynamic import requires a file:// URL on Windows; raw absolute paths
  // like F:\…\dist\entry.js trip Node's ESM loader with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME because the drive letter looks like
  // an unknown protocol scheme.
  await import(pathToFileURL(distEntry).href);
} else if (existsSync(srcEntry)) {
  // Dev fallback: load TypeScript source via tsx's ESM loader. Using the
  // shim's directory (not cwd) as the loader base URL so bare-specifier
  // resolution finds brigade's own node_modules even when the user is
  // running from an unrelated working directory.
  try {
    const { register } = await import("node:module");
    register("tsx/esm", pathToFileURL(here + "/"));
    await import(pathToFileURL(srcEntry).href);
  } catch {
    console.error("brigade: dist/entry.js not found and tsx loader unavailable.");
    console.error("Run `npm run build` first, or `npm run dev` for a TS-direct run.");
    process.exit(1);
  }
} else {
  console.error("brigade: no entry point found (looked for dist/entry.js and src/entry.ts).");
  process.exit(1);
}
