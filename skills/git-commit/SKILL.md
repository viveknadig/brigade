---
name: git-commit
description: Stage, write, and structure git commits and pull requests cleanly. Read this before committing — for conventional-commit message format, when to split commits, and how to open a PR with the gh CLI.
requires-bins: git
---

# Git commits & PRs

Use this when committing changes or opening a pull request.

## Before committing

- Run `git status` and `git diff --staged` to see exactly what's going in. Never `git add -A` blindly — stage the files that belong to this change.
- Keep one logical change per commit. If the diff does two unrelated things, make two commits.
- Don't commit secrets, large binaries, or generated artifacts. Check `.gitignore` covers them.

## Message format

Conventional Commits:

```
<type>(<optional scope>): <short imperative summary>

<optional body — what changed and WHY, wrapped at ~72 cols>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.

- Summary in the imperative mood ("add", not "added"), ≤72 chars, no trailing period.
- The body explains the reasoning a future reader needs — not a restatement of the diff.

## Pull requests (gh CLI)

- `git push -u origin <branch>` then `gh pr create --fill` (or `--title`/`--body`).
- PR body: what changed, why, and how it was verified (tests run, manual checks).
- Confirm the base branch is correct before creating.

## Conventions to honor

Match the repository's existing style — read recent `git log --oneline` first and follow whatever format the project already uses if it differs from the above.
