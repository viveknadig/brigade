# Contributing to Brigade

Thanks for your interest in improving Brigade! This guide covers how to get a
dev environment running, the conventions we follow, and how changes get
released.

## Getting started

Requirements:

- **Node.js 22.12 or newer** (`node --version`) — the runtime uses
  `using` / `AsyncDisposable` and other v22.12 features.
- **npm 10+** (ships with Node 22).
- **git**.

```bash
git clone https://github.com/spinabot/brigade.git
cd brigade
npm install
npm run build
```

Run the CLI from your checkout:

```bash
npm run dev            # smart runner — rebuilds dist/ if src/ is newer
# or, no build step:
npm run dev:tsx        # run TypeScript directly via tsx
```

To make the `brigade` binary available globally while you work:

```bash
npm link
brigade --help
```

## Before you open a PR

Run the full local check suite — CI runs the same commands:

```bash
npm run typecheck      # tsc --noEmit, strict
npm test               # node:test, tempdir-isolated
npm run build          # ensure the production build compiles
```

All three must pass. New behaviour should come with tests next to the code
it covers (`*.test.ts` beside the source file).

## Coding conventions

- **TypeScript strict** — no `any` escapes without a clear reason.
- **ESM only** — use `.js` extensions in relative import specifiers (we compile
  TS → ESM).
- **Match the surrounding code** — naming, comment density, and idioms should
  read like the file you're editing.
- **No secrets in source** — never commit API keys, tokens, real phone numbers,
  emails, or local absolute paths. Config secrets use `${VAR_NAME}` references
  that resolve at read time and are restored (not persisted resolved) on write.
- **Keep state under `~/.brigade/`** — Brigade owns exactly one state directory.
  Don't introduce new global state locations.

## Commit messages & releases

Brigade uses [Conventional Commits](https://www.conventionalcommits.org/) with
an automated release flow:

- `feat:` / `fix:` / `perf:` / `deps:` / `revert:` — trigger a Release PR and,
  once merged, an npm publish.
- `docs:` / `refactor:` / `test:` / `ci:` / `chore:` — do **not** trigger a
  release.

Use a clear, imperative subject line, e.g. `feat(cron): support IANA tz in add`.

## Reporting bugs & requesting features

Open an issue using the templates in the issue tracker. For security
vulnerabilities, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Be excellent to each other

Keep discussions respectful and on-topic. Assume good faith, help newcomers, and
keep the project welcoming. Maintainers may moderate or remove contributions that
are abusive, off-topic, or disruptive.

## Contact

- **Questions & ideas** — open a
  [GitHub Discussion](https://github.com/spinabot/brigade/discussions) or email
  **hello@brigade-agent.ai**.
- **Security issues** — do not open a public issue; see [SECURITY.md](SECURITY.md) or
  email **security@brigade-agent.ai**.
