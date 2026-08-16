# Security Policy

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
[the repository](https://github.com/bardesss/arr-mcp/security/advisories/new).
That opens a channel only you and I can read, which is what you want before
anything is fixed.

If that page is unavailable to you for any reason, open a normal issue saying
you have found something and want a private channel — **without the details** —
and I will open one.

Please include, as far as you have it: the arr-mcp version, how it is deployed
(Docker image or from source), which services are configured, and the smallest
sequence of calls that shows the problem. A confirm token or bearer token from
your own instance is not useful to me and should stay yours; redact them.

## What to expect

This is a one-person project, so the honest version rather than a
service-level agreement: I will acknowledge a report within a week, tell you
whether I agree it is a vulnerability and why, and keep you updated while it is
being fixed. Fixes ship as a normal release with the advisory published
alongside. There is no bounty. Credit in the advisory if you want it, and none
if you would rather not be named.

**Only the latest release is supported.** There are no backports to older
versions; the fix will be in the next release and the upgrade is a tag change.

## Scope

Things worth reporting:

- Reaching `/mcp` or the config UI without valid credentials, or any bypass of
  `allowed_hosts`.
- Any way to read a service API key, the bearer token, or the config UI
  password hash out of a tool response, a log line, an error message or the
  audit trail.
- Any way to make a write happen without passing the permission tier, or with a
  confirmation token that was not issued for that exact operation and target.
  This includes a token bound to one target being accepted for another.
- Content from a configured service escaping its fence and reaching the model as
  instruction rather than as data.
- Anything wrong with the published image's provenance, or with the release
  workflow that builds it.

Things that are known and documented rather than vulnerabilities:

- **No OAuth.** arr-mcp authenticates with a single bearer token by design. See
  [MCP07](docs/security.md#mcp07-insufficient-authentication-and-authorization).
- **Binding `0.0.0.0`, and exposure to the internet.** The container has to be
  reachable across the LAN. It is
  [not designed to be internet-facing](README.md#security), and forwarding the
  port to it is a deployment decision, not a defect.
- **`config.yaml` is plaintext.** Filesystem permissions on the config volume
  are the boundary; there is no encryption at rest.
- **A model that confirms its own preview.** The confirm handshake guarantees
  that the *first* call cannot mutate anything, not that a determined caller
  cannot call twice. See
  [MCP06](docs/security.md#mcp06-intent-flow-subversion).
- **Vulnerabilities in Radarr, Sonarr, Jellyfin and the rest.** Report those to
  the projects themselves. If arr-mcp makes one materially easier to reach, that
  part *is* in scope, so say so.

## Threat model

[docs/security.md](docs/security.md) sets out what this server defends against,
how, and what it deliberately does not solve, walked against the OWASP MCP Top
10. Reading the "what it does not solve" paragraphs first is the quickest way to
tell whether what you have found is already known.
