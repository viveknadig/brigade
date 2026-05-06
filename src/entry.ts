import { runMain } from "./cli/run-main.js";

// Defensive second compile-cache enable. brigade.mjs already does this, but
// `tsx src/entry.ts` and `node dist/entry.js` direct invocations bypass the
// bin shim, so re-enable here. Both are no-ops if already cached.
try {
  const mod = await import("node:module");
  if (typeof mod.enableCompileCache === "function") {
    mod.enableCompileCache();
  }
} catch {
  // Older Node minors silently skip.
}

// brigade is a CLI tool; entry.ts always runs the program. If brigade ever
// grows a library surface, that surface lives at a different export path
// (e.g. `brigade/lib`) — never re-route through entry.ts.
const exitCode = await runMain(process.argv);
process.exit(exitCode);
