# Security Policy

## Supported versions

Brigade is pre-1.0 and ships from `main`. Security fixes land on the latest
published release. Please always run the most recent version before reporting.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's
[private vulnerability reporting](https://github.com/spinabot/brigade/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version(s) and environment.
- Any suggested remediation.

We aim to acknowledge reports within 5 business days and to provide a remediation
timeline after triage. Please give us reasonable time to investigate and patch
before any public disclosure.

## Scope

Brigade is a local-first CLI. Notable security-relevant surfaces:

- **Credentials** — provider API keys and OAuth tokens are stored under
  `~/.brigade/` with `0600` permissions on POSIX. They are never transmitted
  anywhere except to the provider you configured.
- **Gateway** — binds to `127.0.0.1` by default. Exposing it to other interfaces
  is at your own risk; clients authenticate via an Ed25519 pairing handshake.
- **Tool execution** — the `bash` tool is gated by a per-agent approval
  allowlist (`brigade exec`).
- **Channels** — inbound channel peers are gated by per-channel allowlists and
  per-call ownership checks.

Reports that depend on an attacker already having local filesystem access to the
operator's home directory, or on the operator deliberately exposing the gateway
to a hostile network, are generally considered out of scope.
