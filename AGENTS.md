# Brigade — Agent Instructions

From-scratch rebuild whose architecture is informed by an internal reference
codebase audit. Brigade borrows that prior system's *patterns* and *invariants*
— never its name, paths, or branding.

## Naming rules (MUST follow)

- The product is **Brigade**. Never write the prior reference codebase's name
  anywhere — code, comments, user-facing output, env vars, daemon labels,
  paths, or docs.
- Storage dir: `~/.brigade/` (env override: `BRIGADE_STATE_DIR`)
- Config file: `~/.brigade/brigade.json` (env override: `BRIGADE_CONFIG_PATH`)
- Daemon labels:
  - macOS: `ai.brigade.gateway` (launchd plist `com.brigade.gateway.plist`)
  - Linux: `brigade-gateway` (systemd unit)
  - Windows: `Brigade Gateway` (Task Scheduler + HKCU\...\Run)
- Agent SDK in code/docs is **only** `pi` / `@mariozechner/pi-coding-agent`.
  Never name any other 3rd-party AI coding agent project — in source,
  comments, copy, or docs.

## Architecture invariants (mirrored from the reference audit)

- **Auth files** live at `<agentDir>/agent/{auth-profiles,auth-state,models}.json`
  with mode `0600` — NOT under a hidden `.brigade/` subfolder.
- **Sessions** are Pi SDK JSONL transcripts: `<agentDir>/sessions/<sessionId>.jsonl`.
  One file per session. The session-key index lives at
  `<agentDir>/sessions/sessions.json`.
- **Workspace** in a fresh install has **7 files**: `AGENTS.md`, `BOOTSTRAP.md`,
  `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`. `MEMORY.md`
  is created lazily on the first dream cycle, not at onboard.
- **Tasks** are SQLite-persisted at `~/.brigade/tasks/runs.sqlite` (+ WAL/SHM).
  Never store task runs only in memory.
- **Config rotation**: 5 forensic snapshots — `.bak` + `.bak.{1..4}` — with all backup files hardened to mode 0600 on POSIX after each rotation.
- **Secrets** in `brigade.json`: `${VAR_NAME}` references must be RESTORED on
  write — the resolved value never persists to disk.
- **Heartbeat**: workspace-driven via `HEARTBEAT.md`, default 30m, strip the
  `HEARTBEAT_OK` token from agent output before sending.

## Build & package management

- **Brigade is an npm project — never `pnpm` / `pnpx`.** All scripts, README,
  error messages, and chat-side suggestions must use `npm` / `npx`.
- TypeScript → `dist/` via `tsc`. No bundler at this stage.
- `npm run dev -- onboard` runs `src/entry.ts` directly via `tsx` for fast iteration.
- `npm run brigade -- <args>` runs the built `dist/entry.js` via the `brigade.mjs` shim.

## Commit policy

- Never add a `Co-Authored-By: Claude` trailer (per user's repo-wide rule).
- Commit messages explain *why*, not *what*.
