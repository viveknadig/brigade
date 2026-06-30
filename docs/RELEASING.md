# Releasing Brigade

Brigade publishes to npm as [`@spinabot/brigade`](https://www.npmjs.com/package/@spinabot/brigade)
using an automated [release-please](https://github.com/googleapis/release-please)
flow. You almost never run npm commands by hand.

## The flow

1. **Land work on `main`** with [Conventional Commit](https://www.conventionalcommits.org/)
   messages:
   - `feat:` / `fix:` / `perf:` / `deps:` / `revert:` → counts toward a release.
   - `docs:` / `refactor:` / `test:` / `ci:` / `chore:` → no release.

2. **release-please opens/updates a "Release PR"** automatically (see
   `.github/workflows/release.yml`). The PR bumps `version` in `package.json`,
   updates `CHANGELOG.md`, and aggregates everything since the last release.

3. **Merge the Release PR** when you want to ship. release-please then:
   - creates a git tag (e.g. `v1.12.0`) and a GitHub Release, and
   - triggers the `publish-npm` job, which runs `npm ci`, `npm run build`,
     `npm test`, and `npm publish --access public` (with `--provenance` added
     automatically when the repo is public — see below).

That's it — the new version is live as `npm i @spinabot/brigade`.

## One-time repository setup

The publish job needs credentials. Pick **one**:

### Option A — npm Automation token (current setup)

1. On npmjs.com, create an **Automation** access token (Account → Access Tokens →
   Generate New Token → *Automation*) with publish rights to the `@spinabot` scope.
2. Add it as a repo secret named `NPM_TOKEN`, either:
   - **CLI:** `gh secret set NPM_TOKEN --repo spinabot/brigade` (paste the token at
     the prompt — it is not echoed or logged), or
   - **UI:** Settings → Secrets and variables → Actions → New repository secret.

**Provenance** is published automatically once the repo is **public**, and skipped
while it is private — the publish step detects `github.event.repository.private`, so
no workflow edit is needed when you flip visibility.

### Option B — npm Trusted Publishing (OIDC, no stored token)

1. On npmjs.com, open the `@spinabot/brigade` package settings (or the scope's
   settings before first publish) and add a **trusted publisher** pointing at
   `spinabot/brigade` with workflow `release.yml`.
2. Remove the `NODE_AUTH_TOKEN` env line from the publish step in
   `.github/workflows/release.yml`. The OIDC `id-token: write` permission and a
   recent npm (the workflow upgrades npm) handle auth with no secret.

### Recommended branch protection

- Protect `main`; require the `CI` workflow to pass before merge.
- (Optional) Add an `npm-release` **environment** with required reviewers so a
  human approves each publish. The workflow already targets that environment.

## Manual publish (break-glass)

If automation is unavailable, publish from a logged-in machine
(`npm login`, or an `NPM_TOKEN` in your environment):

```bash
npm ci
npm run build
npm test
npm publish --access public
```

> Do **not** add `--provenance` here. Provenance can only be generated inside a
> supported CI run (GitHub Actions OIDC) on a **public** repo — the flag fails on a
> local machine. The release workflow attaches provenance for you.

To keep release-please's state consistent after a manual publish, bump `version` in
`package.json`, set the matching version in `.release-please-manifest.json`, and tag
the commit `vX.Y.Z`.
