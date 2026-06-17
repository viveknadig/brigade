// src/storage/factory-reset.ts
//
// Factory-reset the LOCAL Brigade state so a re-onboard lands VIRGIN — byte-for-
// byte the same starting point as a first-ever onboard, with NO carryover of the
// previous install's workspace personas, skills, sessions, or memory facts.
//
// Why this exists: the "clean slate" paths used to clear only the Convex backend.
// The local ~/.brigade tree (workspace, skills, sessions, facts.jsonl, the
// workspace-setup stamp) always survived and was re-mirrored / re-read on the
// next boot, so "Start fresh" was NOT a fresh start. This wipes it.
//
// What is intentionally NOT touched:
//   • The encryption key — it lives OUTSIDE the state dir (OS config dir) and is
//     retired-to-`.bak` separately, never destroyed, so an OLD backup of the
//     erased data stays readable.
//   • The Convex backend — the caller erases that explicitly (it's a different
//     store); this helper only clears the LOCAL side.
//
// Caller contract: the gateway MUST be stopped first (open file handles +
// write-behind chains would otherwise race a directory removal), and the mode
// sentinel must be re-pinned afterward if the chosen mode should persist (the
// onboard wizard pins it after this runs; `store reset` deletes it on purpose).

import * as fs from "node:fs";

import { resolveStateDir } from "../config/paths.js";

/**
 * Remove the entire local Brigade state dir (`~/.brigade` by default) so the
 * next onboard/boot re-seeds defaults. Idempotent (`force` — a missing dir is
 * fine). Returns the path that was cleared.
 */
export function wipeLocalBrigadeState(stateDir: string = resolveStateDir()): string {
	fs.rmSync(stateDir, { recursive: true, force: true });
	return stateDir;
}
