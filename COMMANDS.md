# 🦁 Brigade — commands reference

Every command you can run end-to-end, grouped by surface. **Source of truth: [`src/cli/program/build-program.ts`](src/cli/program/build-program.ts)** — when commands change there, this file should change too (see [keeping this file in sync](#keeping-this-file-in-sync) at the bottom).

> Conventions
> - Anything in `<angles>` is a required argument; anything in `[brackets]` is optional.
> - Every read-only command supports `--json` for machine-readable output.
> - The dev runner is `node F:/Brigade/brigade.mjs <…>` (or `npm run start -- <…>`). After `npm install -g .` you can just type `brigade …`.

---

## 🚀 Quick start

```bash
# 1. One-time provider setup
brigade onboard

# 2. Daily use — in-process TUI (auto-starts gateway)
brigade

# OR — daemon + thin client (preferred for long sessions)
brigade gateway          # terminal A
brigade connect          # terminal B
```

---

## 🎛️ Top-level commands

| Command | Description |
|---|---|
| `brigade` *(default)* / `brigade tui` | Launch the chat TUI (auto-starts gateway if needed) |
| `brigade onboard` | Pick a provider + model — interactive wizard |
| `brigade agent <prompt>` | Drive a single turn through the agent pipeline (one-shot, non-interactive) |
| `brigade connect` | Thin TUI client that talks to a running gateway |
| `brigade status` | Snapshot of Brigade config, sessions, gateway state |
| `brigade doctor` | Full health check (config / providers / log sink / system prompt assembly / optional gateway probe) |
| `brigade logs [--follow]` | Tail today's gateway log |

### Common flags

| Flag | Where | Meaning |
|---|---|---|
| `--host <host>` | gateway/connect/status/doctor | Gateway host (default `127.0.0.1`) |
| `--port <port>` | gateway/connect/status/doctor | Gateway port (default `7777`) |
| `--json` | almost every command | Machine-readable output |
| `--no-env-detect` | onboard, tui | Ignore API keys from shell env |

---

## 🛰️ Gateway

```bash
brigade gateway run                  # foreground; alias for bare `brigade gateway`
brigade gateway status               # is the daemon up? on what port?
brigade gateway stop [--timeout <ms>]
brigade gateway install              # register as OS service (launchd / systemd / Task Scheduler)
brigade gateway uninstall
brigade gateway restart
```

Gateway-level flags accepted on `run` / bare `brigade gateway`:

| Flag | Effect |
|---|---|
| `-p, --port <n>` | TCP port to bind |
| `-h, --host <addr>` | Interface to bind |
| `-V, --verbose` | Raise log level to `debug` |
| `-q, --quiet` | Disable console stream |
| `--log-level <lvl>` | One of `trace`/`debug`/`info`/`warn`/`error`/`fatal` |

---

## ⚙️ Config

`brigade.json` lives at `~/.brigade/brigade.json` (or `%USERPROFILE%\.brigade\brigade.json`). Edit it directly OR via these commands:

| Command | Description |
|---|---|
| `brigade config list` | Print full config (secrets redacted) |
| `brigade config get <path>` | Get a single value at dotted path (e.g. `agents.defaults.provider`) |
| `brigade config set <path> <value>` | Set a value (JSON or string) — supports `--strict-json` + `--dry-run` |
| `brigade config unset <path>` | Remove a key |
| `brigade config file` | Print the absolute path to your config |
| `brigade config schema` | Print the TypeBox schema as JSON |
| `brigade config validate` | Validate config against the schema; exit non-zero on issues |

---

## 📡 Channels

WhatsApp, Slack, Telegram, Discord, etc. — anything wired through Brigade's channel adapters.

```bash
brigade channels list                          # which channels are configured / linked / started
brigade channels status [--channel <id>]
brigade channels link [--channel <id>] [--force] [--timeout <ms>]
brigade channels unlink [--channel <id>] [-y]
brigade channels enable [--channel <id>]
brigade channels disable [--channel <id>]
```

### Allow-list (who's permitted to DM the agent)

```bash
brigade channels allow list [--channel <id>]
brigade channels allow add <senderId> [--channel <id>]      # e.g. +15551234567
brigade channels allow remove <senderId> [--channel <id>]
```

### Pairing (operator-side approvals for new device connections)

```bash
brigade pairing list                      # show pending pair codes
brigade pairing approve <code>
brigade pairing revoke <code>
```

---

## 🧑‍🤝‍🧑 Agents — isolated personas

Each agent has its own workspace (persona files), auth profiles, exec allowlist, sessions, and optional channel/account routing bindings. `brigade.json` stores them under `cfg.agents.<id>` (keyed map) and `cfg.bindings.entries[]` (routing rules). The bare `brigade agents` invocation defaults to `list`.

```bash
brigade agents                                                # list every agent (default)
brigade agents list [--json] [--bindings]
brigade agents bindings [--agent <id>] [--json]
brigade agents bind --agent <id> --bind <spec> [--bind <spec> …] [--json]
brigade agents unbind --agent <id> (--bind <spec> [--bind <spec> …] | --all) [--json]
brigade agents add <name> [--workspace <dir>]
                  [--model <id>] [--provider <id>] [--agent-dir <dir>]
                  [--bind <spec> [--bind <spec> …]]
                  [--non-interactive] [--json]
brigade agents set-identity --agent <id>
                  [--workspace <dir>] [--identity-file <path>] [--from-identity]
                  [--name <…>] [--theme <…>] [--emoji <…>] [--avatar <…>]
                  [--json]
brigade agents delete <id> --force [--json]
```

**Binding spec shape**

A binding spec is either a bare channel id (`whatsapp`, `telegram`, `discord`) or `<channel>:<accountId>` to scope the binding to a single account (`whatsapp:+15551234567`). Bindings are first-come-first-served across agents — a slot already owned by another agent is reported as a conflict (exit-1) instead of silently re-routed.

**Reserved ids**

`main` (the default agent), `none`, `null`, `undefined`, `default`, `all`, and `any` are reserved and cannot be used as agent ids. `main` additionally cannot be `delete`d.

**Workspace defaulting**

`agents add <name>` without `--workspace` auto-defaults to `~/.brigade/agents/<name>/workspace/`. Pass `--workspace <dir>` only when you want a custom location.

**Interactive parity**

`add`, `delete`, and `set-identity` ship non-interactive first. The interactive wizard (workspace picker, identity prompts, delete confirm) is a follow-up; until it lands these commands fail loudly with a clear message rather than blocking on a TTY prompt.

---

## 🗂️ Sessions

Per-agent transcripts at `~/.brigade/agents/<id>/sessions/`.

```bash
brigade sessions list [--agent <id>]                 # newest first
brigade sessions cleanup --older-than <30d|12h>      # supports --dry-run
```

---

## 🧠 Skills

Prompt-resident skills auto-discovered from bundled + workspace dirs.

```bash
brigade skills list                  # everything visible to the assembler
brigade skills info <name>           # full SKILL.md body
```

---

## 🔐 Exec — bash approval gate

Brigade's bash tool is gated. The operator builds an allowlist of safe commands.

```bash
brigade exec list                                    # show allowlist (commands + patterns)
brigade exec allow <command…>                        # approve an exact command
brigade exec allow-pattern <regex>                   # approve a regex pattern
brigade exec remove <command-or-pattern>             # drop from allowlist
brigade exec deny-test <command…>                    # how would the gate classify this?
brigade exec file                                    # absolute path to exec-approvals.json
```

All accept `--agent <id>` to scope to a non-default agent (default `main`).

**Examples**
```bash
brigade exec allow ls -la
brigade exec allow-pattern '^git (status|diff|log)( |$)'
brigade exec deny-test 'rm -rf /'
```

---

## ⏰ Cron — scheduled jobs

Per-agent recurring / one-shot tasks. Service lives in the gateway; this CLI talks directly to `~/.brigade/cron.json`.

```bash
brigade cron status                       # service health
brigade cron list [--all] [--query <text>] [--limit <n>]
brigade cron add  --name <name> (--at <iso|ms> | --every <5m|1h> | --cron <expr>)
                  (--message <prompt> | --system-event <text>)
                  [--tz <iana>] [--target main|isolated|session:<id>]
                  [--model <id>] [--thinking off|low|medium|high]
                  [--timeout-seconds <n>] [--tools <csv>] [--light-context]
                  [--deliver | --no-deliver]
                  [--channel <id>] [--to <addr>] [--account <id>]
                  [--best-effort-deliver] [--disabled]
brigade cron edit <jobId>   [--name <…>] [--description <…>] [--enable | --disable]
brigade cron rm <jobId>     # also: remove / delete
brigade cron enable <jobId>
brigade cron disable <jobId>
brigade cron run <jobId>    [--due]    # fire now (force) or only if past next-fire (due)
brigade cron runs <jobId>   [--limit <n>]
```

**Schedule shapes**

| Kind | Example | Use for |
|---|---|---|
| `--at` | `--at 2026-06-04T02:00:00+05:30` or `--at 1780510620000` | One-shot fires |
| `--every` | `--every 5m` / `--every 1h` / `--every 30s` | Fixed-interval recurring |
| `--cron <expr> --tz <iana>` | `--cron "0 9 * * *" --tz Asia/Kolkata` | Calendar-aligned recurring |

> ⚠️ **Always pair `--cron` with `--tz`** using a full IANA zone (`Asia/Kolkata`, `America/Los_Angeles`, `Europe/London`). Abbreviations like `IST` / `PT` are not valid IANA zones.

**Payload shapes**

| Flag | Pairs with | Effect |
|---|---|---|
| `--message <prompt>` | default `target=isolated` | A fresh agent turn runs the prompt at fire time |
| `--system-event <text>` | default `target=main` | Text is injected into the operator's main session inbox |

---

## 💾 Backup

```bash
brigade backup create [--out <path>]            # archive of brigade.json + workspace + skills + sessions
brigade backup verify <archive>                 # checksum + structure check
brigade backup restore <archive>                # to a fresh ~/.brigade/
```

---

## 🔍 Diagnostics

```bash
brigade doctor [--strict]                       # full health check; --strict exits non-zero on warnings
brigade secrets audit                           # scan config / disk for unexpected secret leaks
brigade logs [--follow]                         # tail today's gateway log
```

---

## ⌨️ TUI slash commands

Inside `brigade` / `brigade connect` / `brigade chat` you can type:

| Slash | What it does |
|---|---|
| `/help` | Full slash-command list (live) |
| `/usage` | Token + cost summary for this session |
| `/model [provider id]` | Switch model mid-session |
| `/thinking [off\|low\|medium\|high]` | Adjust reasoning budget |
| `/compact` | Force a transcript compaction now |
| `/reasoning [on\|off]` | Toggle showing thinking blocks |
| `/abort` | Abort the in-flight turn (or Ctrl+C) |
| `/agent [id]` | Switch the connection's bound agent |
| `/session [key]` | Switch the connection's bound session |
| `/agents` | List configured agents |
| `/sessions [--all]` | List sessions for bound agent (or all) |
| `/mute <id\|key>` | Server-side unsubscribe from an agent or session |
| `/provider` *(chat-only, not connect)* | Re-run provider onboarding inline |

> `connect` mode intentionally omits `/provider` — onboarding writes to the gateway machine's filesystem, which a thin client can't reach.

---

## 🛠️ npm scripts (developer mode)

In a checkout of `F:/Brigade`:

| Script | What |
|---|---|
| `npm run dev` | Run the bin shim against current source — auto-rebuilds `dist/` if stale |
| `npm run dev -- onboard` (etc.) | Same but pass subcommand args |
| `npm run start` | Same as `dev` |
| `npm run tui` | Direct TUI launch via the dev runner |
| `npm run gateway` | Direct gateway launch via the dev runner |
| `npm run onboard` | Onboarding via the dev runner |
| `npm run agent -- <prompt>` | One-shot agent turn via the dev runner |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/` |
| `npm run typecheck` | `tsc --noEmit` (no emit) |
| `npm test` | `tsx --test src/**/*.test.ts` — runs the full test suite |
| `npm run clean` | Remove `dist/` |
| `npm run watch` | `tsx --watch src/entry.ts` for live dev |

---

## 📁 File locations

| Path | What |
|---|---|
| `~/.brigade/brigade.json` | Main config (atomic write + `.bak.{1..4}` rotation) |
| `~/.brigade/auth.json` | Provider auth (mode 0600) |
| `~/.brigade/models.json` | Custom-provider catalog |
| `~/.brigade/cron.json` | Cron job store (lock-serialised) |
| `~/.brigade/cron/runs/<jobId>.jsonl` | Per-job run history |
| `~/.brigade/agents/<id>/workspace/` | Persona files (`SOUL.md` / `IDENTITY.md` / `AGENTS.md` / `TOOLS.md` / `USER.md` / `BOOTSTRAP.md` / `HEARTBEAT.md`) |
| `~/.brigade/agents/<id>/sessions/` | JSONL transcripts |
| `~/.brigade/agents/<id>/agent/auth-profiles.json` | Per-agent auth profiles |
| `~/.brigade/agents/<id>/workspace/memory/facts.jsonl` | Per-agent durable facts |
| `~/.brigade/agents/<id>/exec-approvals.json` | Per-agent bash allowlist |
| `~/.brigade/logs/<date>.jsonl` | Structured gateway logs |
| `~/.brigade/channels/<channel>/<accountId>/` | Per-account channel state (auth, allow-from, pairing) |
| `~/.brigade/workspace/memory/` *(legacy)* | Top-level workspace memory (older installs) |

---

## Keeping this file in sync

`COMMANDS.md` is **hand-maintained** but anchored to a single source of truth. When you change the CLI:

1. The canonical command registration is [`src/cli/program/build-program.ts`](src/cli/program/build-program.ts). Run `grep -nE '\.command\(|\.description\(' src/cli/program/build-program.ts` to enumerate every command + its description.
2. The TUI slash-command list lives in [`src/cli/commands/connect.ts`](src/cli/commands/connect.ts) (`SLASH_COMMANDS` array) and [`src/ui/chat.ts`](src/ui/chat.ts).
3. Update the table in this file matching the surface that changed.
4. If you add a whole new top-level command, also add a section header (`## 🆕 Name`) above so it's visible in the TOC.

If you want this file regenerated automatically, write a `scripts/sync-commands-doc.mjs` that:
- Imports the Commander `program` from `dist/cli/program/build-program.js`
- Walks `.commands` recursively to emit the same tables
- Writes back to `COMMANDS.md` with a `<!-- auto-generated -->` marker block

Until that script exists, treat any PR that touches `src/cli/program/build-program.ts` as also requiring a `COMMANDS.md` patch in the same change.
