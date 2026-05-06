import { buildProgram } from "./program/build-program.js";

// Single entry point shared by `brigade.mjs` (built) and `npm run dev` (tsx).
// Returns an exit code so the caller decides how to terminate the process.

export async function runMain(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    return mapErrorToExitCode(err);
  }
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
      console.error(`brigade: ${e.message}`);
      return 1;
    }
  }
  console.error("brigade:", err);
  return 1;
}
