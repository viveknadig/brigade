# 🦁 Brigade

> AI crew framework — terminal-first personal assistant.

Brigade is a from-scratch rebuild that borrows architectural patterns from a
prior internal reference codebase (storage layout, channel adapter contract,
8-tier route resolution, Pi SDK kernel) and ships under its own name, paths,
and identity.

## Quick start

```bash
npm install
npm run build
npm run brigade -- onboard    # creates ~/.brigade/ + workspace + auth scaffolding
npm run brigade -- --help
# or, after `npm link` (or once published): brigade onboard, brigade --help
```

Drive a single turn:

```bash
npm run brigade -- agent --provider anthropic --model claude-sonnet-4-6 -m "hello"
```

## Filesystem layout

After `brigade onboard --agent-id default`:

```
~/.brigade/
├── brigade.json                          # main config (JSON5, ${VAR} refs preserved on write)
├── agents/default/
│   ├── agent/
│   │   ├── auth-profiles.json            # OAuth + API keys, mode 0600
│   │   ├── auth-state.json
│   │   └── models.json
│   ├── sessions/
│   │   ├── sessions.json                 # session-key → metadata index
│   │   └── <sessionId>.jsonl             # Pi SDK transcript per session
│   └── workspace/
│       ├── AGENTS.md
│       ├── BOOTSTRAP.md
│       ├── IDENTITY.md
│       ├── SOUL.md
│       ├── TOOLS.md
│       ├── HEARTBEAT.md
│       └── USER.md
├── tasks/runs.sqlite                     # SQLite + WAL/SHM
├── identity/                             # gateway Ed25519 keypair
├── completions/                          # shell completion scripts
├── oauth/                                # pairing codes + allowlists
├── credentials/                          # web provider creds
└── logs/                                 # daily rolling logs + audit trail
```

## Layout (source)

- `src/entry.ts` — process entry (parses argv, dispatches to CLI)
- `src/cli/` — Commander surface (`run-main.ts`, `program/`, `commands/`)
- `src/config/` — `~/.brigade/` path resolution + JSON5 read/write
- `src/workspace/` — 7-file workspace bootstrapping
- `src/auth/` — auth-profiles.json reader/writer
- `src/agents/` — Pi SDK invocation surface
- `src/routing/` — agent route resolution
- `src/version.ts` — single source of truth for the package version

## Environment overrides

- `BRIGADE_STATE_DIR` — alternate state directory (default: `~/.brigade`)
- `BRIGADE_CONFIG_PATH` — alternate config file path

## License

MIT
