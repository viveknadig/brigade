import { friendlyError, translateAuthError } from "../core/auth-error.js";
import { cleanProviderError } from "../core/model-caps.js";
import { buildProgram } from "./program/build-program.js";

// Single entry point shared by `brigade.mjs` (built) and `npm run dev` (tsx).
// Returns an exit code so the caller decides how to terminate the process.

export async function runMain(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(rewriteColonSubcommands(argv));
    return 0;
  } catch (err) {
    return mapErrorToExitCode(err);
  } finally {
    // Safety net for commands that RETURN through here (e.g. `brigade agent`)
    // rather than self-exiting via `exitAfterFlush`. An agent turn enqueues
    // transcript / facts / session writes onto convex write-behind chains;
    // entry.ts calls `process.exit(code)` the instant runMain resolves, so we
    // drain first or those writes are lost. No-op in filesystem mode and when
    // a command already drained (chains are then settled).
    try {
      const { flushAllPendingWrites } = await import("../storage/flush.js");
      await flushAllPendingWrites();
    } catch {
      // Never let a drain failure mask the real exit code.
    }
  }
}

/**
 * Rewrite the `brigade convex:dev` colon form into the canonical
 * `brigade convex dev` two-token form before Commander parses it. The
 * npm-script habit (`npm run convex:dev`) leads operators to type the colon
 * form at the `brigade` CLI too; without this they'd fall through to the
 * default `tui` command and start the gateway. Only the known convex actions
 * are rewritten, so no unrelated argument is touched. Returns a new array
 * (never mutates the caller's argv).
 */
function rewriteColonSubcommands(argv: string[]): string[] {
  const m = /^convex:(dev|start|status|stop|push|codegen)$/.exec(argv[2] ?? "");
  if (!m) return argv;
  return [...argv.slice(0, 2), "convex", m[1]!, ...argv.slice(3)];
}

function mapErrorToExitCode(err: unknown): number {
  if (err && typeof err === "object") {
    const e = err as { code?: string; exitCode?: number; message?: string };
    // Commander signals --help / --version / no-args via these codes.
    // None of them are real errors.
    if (
      e.code === "commander.helpDisplayed" ||
      e.code === "commander.help" ||
      e.code === "commander.version"
    ) {
      return 0;
    }
    if (typeof e.exitCode === "number") return e.exitCode;
    if (e.message) {
      // Translate Pi's auth errors (which leak `/login` references and raw
      // `node_modules/@earendil-works/pi-coding-agent/docs/...` paths) into
      // Brigade-native messages. `translateAuthError` returns its own
      // `⚠`-prefixed message that doesn't need the `brigade:` prefix; for
      // anything else, fall through to `friendlyError` (peels JSON wrappers
      // off provider errors) and prefix as before.
      const translated = translateAuthError(e.message);
      if (translated) {
        console.error(translated);
      } else {
        console.error(`brigade: ${friendlyError(e.message, cleanProviderError)}`);
      }
      return 1;
    }
  }
  console.error("brigade:", err);
  return 1;
}
