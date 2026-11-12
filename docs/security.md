# Security

What arr-mcp does about the risks specific to running an MCP server, what it
deliberately does not do, and where the boundary sits.

The structure follows the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
(v0.1, beta). Each risk gets the same three answers: what it is, what this
server does about it, and what it still does not solve.

To report something, see [SECURITY.md](../SECURITY.md).

## The threat model first

arr-mcp is a **single-operator LAN appliance**. One person configures it, one
set of MCP tokens reaches it, one set of permissions applies. It is not multi-tenant,
it does not federate, and it is
[not designed to be exposed to the internet](../README.md#security).

Within that, two questions are separate and both matter:

| Question | Answered by |
| --- | --- |
| Who may reach this server at all? | MCP tokens or OAuth access tokens, config UI password, `allowed_hosts` |
| What may a caller do once it is in? | Permission tiers, the confirm handshake, the audit trail |

Most published MCP security work stops at the first question.
["Exposed by Design"](https://arxiv.org/abs/2608.00150) (July 2026) audited 640
production servers and found 91.8% without OAuth and 687 instances with
unrestricted shell tool access. arr-mcp answers the first row with a mandatory
token (its own MCP tokens, or OAuth 2.1 access tokens from an identity provider
you already run) and spends most of its design effort on the second: an
authenticated caller is not automatically a trustworthy one, because the caller
is a language model acting on text it read somewhere else.

## MCP01 Token Mismanagement and Secret Exposure

**The risk.** Credentials in logs, in model context, in debug traces, in the
transcript. This server holds every service credential you configure plus the hashes of its own
MCP tokens, so it is a concentrated target.

**What arr-mcp does.**

- Credentials live in `config.yaml` in the mounted config volume. No tool
  returns one, and no tool takes one as an argument.
- Upstream errors carry the **origin and path only**, never the full URL
  (`src/core/http.ts`). SABnzbd authenticates by query parameter, so a logged
  full URL would be a logged API key.
- `get_stack_health`, the management API and the config page all show service
  URLs with any `user:pass@` userinfo stripped (`withoutCredentials` in
  `src/tools/stackHealth.ts`).
- Audit arguments pass through a key-name redactor before they are written, even
  though no write tool accepts a credential today (`src/core/audit.ts`).
- The config UI password is stored as a scrypt hash and nothing else. MCP tokens
  created in the UI are 32 random bytes; one written into `config.yaml` by hand
  must be at least 32 characters. Either is stored only as a SHA-256 hash, and revoking or creating one from the UI takes effect on the very next request.
- The maintenance scripts redact configured hostnames from their output, with a
  test that says so (`test/scriptsRedact.test.ts`).

**What it does not solve.** `config.yaml` is plaintext on disk. There is no
secret manager integration and no encryption at rest, so filesystem permissions
on the config volume are the real boundary. And
[`allow_token_in_url`](configuration.md#allow_token_in_url) puts an MCP
token in the address when you turn it on, which a reverse proxy access log will
record. It is off by default.

## The repair page renders the config file verbatim

The config UI otherwise follows one rule: a secret is never rendered back. API
keys and passwords come back as empty fields with an `unchanged` placeholder. The
[event log's secret](#the-library-event-log) is the one other exception, shown
masked.

The repair page, served when `config.yaml` does not load, breaks that rule. It
shows the file as text, credentials included, because there is no parsed config
to build a form from, and a file with a syntax error cannot be reliably
redacted.

The file's contents go no further than that editor, which is behind the same
session as the rest of the UI, sends `cache-control: no-store`, and is only
reachable while the configuration is invalid. When the sign-in fields in `auth`
cannot be read, no editor is served at all; see
[When config.yaml will not load](configuration.md#when-configyaml-will-not-load).

The *error text* is a separate question, because it is not behind the session:
it is the body of `/healthz`, the body of the 503 from `/mcp`, and the whole of
the read-only page. So it carries a position (`at line 3, column 12`) and never
the line itself, since a YAML syntax error is usually an API key holding a `:`
or starting with a `*`. The parser's own message is stripped of the source it
quotes (`src/config/load.ts`); `/healthz` is read by the Docker healthcheck, so
an unstripped one would sit in the health log for `docker inspect` to print.

A schema error can quote the file too: an unknown key is named in it, and a
mis-indented value can end up in key position. All three drop every quoted
literal, so that reads `Unrecognized key: "…"`, with the path after it. The
startup log keeps the key, so it can hold a secret written that way.

## The library event log

Off by default. While it's off, `/webhooks/*` answers 404 to everyone. While it's
on, Radarr, Sonarr and Lidarr post to it, so it takes requests with neither a session nor
an MCP token.

**How a request is authenticated.** HTTP Basic, because that's what an *arr can
send on a webhook. Any username works and the password is compared in constant
time against `webhooks.secret`. An unauthenticated caller gets a 401 before the
instance is looked up, so it can't find out which instances exist. The Host
allowlist applies, and a body has a 256 KiB limit.

**Only failures are throttled.** After repeated wrong secrets those attempts get a
429, but the right secret always passes, so wrong ones cannot cost you real
events.

**The secret is the exception to two rules.** It's stored in plain text like a
service `api_key` rather than hashed like an MCP token, and the config page renders
it back, masked with CSS and with a button to show it, to a signed-in user, because
it has to be pasted into each service. The management API doesn't return it. All it can do is add rows to the
event log.

**What's stored.** Only named fields: the event, title, internal and external ids,
download id, quality, indexer and delete reason. Paths, URLs, release names and the
instance name are never read, so a credential in one of them doesn't reach
`events.db`. Titles, indexer names and reasons are fenced as upstream text. The
payload doesn't say who deleted something, and so neither does the log. Events are
pruned by age and by row count.

## MCP02 Privilege Escalation via Scope Creep

**The risk.** Permissions granted once, broadly, and never narrowed. The agent
ends up able to do more than anyone consciously decided.

**What arr-mcp does.**

- Two ordered tiers, `safe_write` and `destructive`, both defaulting to false,
  on **every service**, including the ones added by hand-editing YAML. See
  [Writes](writes.md#permissions).
- Permissions are **per instance**. `radarr/hd` can be writable while
  `radarr/4k` is not.
- The gate reads configuration and nothing else (`src/core/permissions.ts`), so
  an adapter cannot widen its own permissions.
- The service whose permissions apply is resolved **from the tool arguments,
  before anything else runs** (`src/tools/write.ts`), so the service checked is
  the one the audit row names and the confirm token binds to.
- Jellyfin and Seerr issue admin-scoped keys, so one key plus a user parameter
  can read anybody's history. `allow_other_users` defaults to false, and the
  gate runs before any network call (`src/core/identity.ts`).

**What it does not solve.** The tiers are coarse on purpose. There is no
per-tool grant, so enabling `destructive` on Radarr enables every destructive
Radarr tool, not just the one you had in mind. If that matters to you, the
finest control available is a second instance entry with its own permissions
block.

## MCP03 Tool Poisoning

**The risk.** Content the server returns is treated by the model as instruction
rather than as data. Prowlarr returns release names from public indexers, so
attacker-controllable strings flow straight into model context.

**What arr-mcp does.** Every piece of free text a service returns is fenced
(`src/core/fence.ts`) before it reaches the model:

- Wrapped in a labelled boundary that names its source.
- The value's own angle brackets are escaped first, so a release name cannot
  close the fence and continue outside it.
- C0 and C1 control characters, zero-width characters, and the bidirectional
  override and isolate ranges are stripped. U+202E, for one, lets a release
  name display as something different from its bytes in an audit log.
- Truncated at 2000 characters, so a single hostile overview cannot crowd out
  everything else in the answer.
- Escaped rather than censored: the words survive verbatim.

Tool definitions themselves are static and registered in-process. Nothing
fetches a tool description from a remote source, so there is no rug-pull surface
where a tool's description changes after you approved it.

**What it does not solve.** Fencing does not make prompt injection impossible.
It makes injected text *visibly* data and removes the characters that let a
string render as something other than what it is. A model that decides to obey
fenced text anyway is not something this server can prevent, which is why the
write path has a second line of defence. See MCP06.

## MCP04 Software Supply Chain and Dependency Tampering

**The risk.** A compromised dependency or a tampered image changes what the
server does without any change to its source.

**What arr-mcp does.**

- Nine runtime dependencies, each added deliberately.
- Dependabot groups non-major updates into one monthly PR per ecosystem.
  Security updates are exempt from both that schedule and the open-PR limit,
  and land as soon as the advisory does.
- Images are built with an SBOM and `provenance: mode=max`, and the pushed
  digest is attested with `actions/attest-build-provenance`, so you can verify
  that the image you pulled came from this repository's workflow.
- The MCP Registry publisher binary is pinned and SHA256-verified rather than
  curled from `releases/latest`.
- `npm ci` from a committed lockfile, everywhere, including inside the image
  build.
- `test/dockerGlibc.test.ts` compares the glibc symbols the shipped
  `better-sqlite3` prebuilds actually import against the Debian suite the
  Dockerfile names, so a prebuild that outgrows the base image fails CI.

**What it does not solve.** There is no dependency pinning by hash beyond the
lockfile, and no reproducible-build guarantee. Provenance tells you where the
image was built, not that its inputs were uncompromised.

## MCP05 Command Injection and Execution

**The risk.** A tool call that reaches a shell or runs a command, as in the 687
unrestricted-shell instances above.

**What arr-mcp does.** There is no shell tool, no `exec`, and no
`child_process` import anywhere in `src/`.

Outbound requests all go through one HTTP client against a base URL the operator
configured. Paths are **prefixed, not resolved** (`src/core/http.ts`), so an
adapter path cannot escape a service's URL base. Configured URLs must be
`http://` or `https://`, validated at startup. No tool accepts a URL or a
hostname as an argument, so no model-controlled string decides a network
destination.

The one path-shaped argument is `add_media`'s `root_folder`, and it is a
**selection, not a value**: the string is matched against the root folders that
service already has configured, and anything matching none of them is refused
with the available list rather than passed through (`chooseOne` in
`src/tools/chooseOne.ts`). The same is true of quality profiles.

**What it does not solve.** Nothing structural outstanding here: the risk was
designed out rather than mitigated.

## MCP06 Intent Flow Subversion

**The risk.** Instructions embedded in context steer the agent away from what
the user actually asked for: MCP03 when the model obeys the injected text.

**What arr-mcp does.** This is what the confirm handshake exists for
(`src/core/confirm.ts`, and [Writes](writes.md) for the user-facing version).

A write tool called without `confirm` performs nothing. It returns a preview
plus a token, and only a second call carrying that token mutates anything.

- The token is an **HMAC over the exact operation**: tool, service, tier,
  operation, resolved target, and every effect-bearing argument. A token issued
  for "delete movie 5" cannot be replayed as "delete movie 9".
- It binds to the **resolved id, not the phrase the user typed**, so a token
  cannot survive re-resolving a title to a different film.
- **Single-use**, so "add movie" cannot be confirmed twice into a duplicate.
- **Five-minute TTL**, so a token found in an old transcript is dead.
- The signing key is fresh per process and never written down, so a restart
  invalidates outstanding tokens.
- Expiry is checked before the signature so an old token reports "expired"
  rather than a misleading "mismatch"; the spent-token check happens after the
  signature, so an unsigned guess cannot probe which tokens have been used.
- Surrounding backticks, quotes and trailing punctuation are stripped before the
  token is parsed, since the preview quotes it in backticks before a period.
  Nothing about the check relaxes: none of
  those characters can occur in a token, the HMAC still decides, and the stripped
  form is what the single-use set records.
- `dry_run` is a terminal preview that never issues a token and is never refused
  by the permission tier, so it answers what a write would do without granting
  anything.

**What it does not solve.** The handshake does not stop a determined model, which holds the token and can simply call twice. What it
guarantees is that the **first** call cannot mutate anything, so a mis-parsed
instruction surfaces as a preview a human can see and an audit row that exists
either way. The control is visibility before the fact, not impossibility.

## MCP07 Insufficient Authentication and Authorization

**The risk.** Servers that verify nothing.

**What arr-mcp does.**

- `/mcp` requires a bearer token. There is no unauthenticated mode and no
  "trusted network" bypass: a home network contains guest phones and IoT
  devices.
- [`--stdio`](configuration.md#over-stdio) takes no token, because nothing
  crosses a network: the client is whoever could start the process. It is
  read-only for that reason, with no setting to change it, so writes always go
  through `/mcp` and a token's tier.
- The tokens are read from the runtime on **every request**, so revoking or
  creating one takes effect immediately rather than at the next restart.
- The config UI has its own scrypt-hashed password with a 12 character minimum
  and a signed session cookie. The session lasts 30 days from the last page you
  opened and renews itself as you use the UI, while background polling such as
  the Logs auto-refresh does not count. It survives restarts and updates, because
  the signing key is kept in `sessions.json` beside `config.yaml`, with owner-only
  permissions. It is a bigger target than the MCP endpoint, because it displays
  every service's API key and can change them, so sign out on a shared machine.
  The cookie is marked `Secure` when the page was reached over https, directly
  or through a proxy sending `X-Forwarded-Proto: https`, and not over plain
  http, where a browser would refuse to store it. Cookies are scoped to the
  hostname, not the port, so use one scheme per hostname, or a plain-http
  sign-in after an https one can bounce back to the login page.
- `/ui/login` throttles itself after 5 free failed attempts, then delays each
  further one with a growing backoff capped at 5 minutes. The counter is kept
  per socket peer, which cannot be forged. A request carrying `X-Forwarded-For`
  or `Forwarded` shares one bucket instead, since the address behind a proxy is
  unverifiable, and a direct client can also fill it.
- A log line records two addresses where they differ: `ip` is the peer the
  socket actually came from, and `forwardedFor` is the first hop of
  `X-Forwarded-For` when a request carried one. The header is caller-supplied
  and there is no trusted-proxy list, so treat `forwardedFor` as a claim.
- Sessions end when you end them: signing out revokes that session, and changing
  the password revokes every session issued before it, whether it was changed in
  the UI or by hand in `config.yaml`. A restart does not undo either. Deleting
  `sessions.json` and restarting signs
  everyone out. Anyone who can read that file could forge a session, the same
  people who can already read `config.yaml` and every API key in it.
- `allowed_hosts` is validated per request rather than frozen at startup.
- When `auth.oauth` is configured, `/mcp` also accepts a short-lived OAuth 2.1
  access token in place of an MCP token. The token's signature,
  issuer, audience and expiry are verified against the issuer's JWKS, and its
  scope becomes a ceiling on what `config.yaml` already permits, narrowing
  it, never widening it, and enforced by the same gate that governs an
  MCP token's tier. `/.well-known/oauth-protected-resource` serves the RFC 9728
  metadata document, and the 401 challenge carries `resource_metadata=`
  pointing at it, whether or not a token verifies. With no `oauth` block,
  both are unchanged: the route 404s and the challenge names only the realm.
- Verifying a token means one outbound request: fetching the issuer's JWKS
  from `jwks_uri`, which the operator configures and this server never
  derives or discovers on its own. No credential leaves the box making it.
  When that fetch fails, `/mcp` answers `503`, not `401`: a fetch outage is
  never reported as a bad credential. The one exception is a token whose unverified `exp` has
  passed: it is refused either way, so it gets the `401` that points at the
  real problem. The unverified claim only picks which refusal is sent.

The management API at `/api/v1` is off by default and answers 404 until you
create a key on the config page. Each key is named, 256 bits, stored as a SHA-256
hash, and accepted only in the `X-Api-Key` header, never in a URL. A key is never
valid on `/mcp`, and an MCP token is never valid there.

A `read` key can use `GET` and `HEAD` and nothing else, so a leaked one exposes
what the API shows, which never includes a secret. The check sits in front of
every route, so an endpoint added later is closed to it by default.

An `admin` key can write config: services, their permissions, IMDb,
`allowTokenInUrl` and MCP tokens. Treat it like an admin credential. No key can
change `allowed_hosts` (that could lock the owner out of the config page), the
sign-in, OAuth or the management keys, so a leaked key cannot make more of
itself. Through a connection test, or by saving a new URL for a service, an admin
key can send the stored credential of any configured service to a host of its
choosing. Both are logged with the target's origin, never its path, query or
credentials, and with the key's name and fingerprint. MCP tokens it creates
outlive the key, so if an admin key leaks, revoke it on the config page and also
review the token list there.

Request bodies are capped at 4 MB, refused with `413` before authentication
runs. The cap is not configurable.

**What it does not solve.** OAuth mode does not extend to the config UI, whose
credential stays a scrypt-hashed password and a session cookie. There is no revocation beyond expiry: this
server does not introspect tokens, so one revoked at the issuer but not yet
expired is still accepted here until it runs out. TLS is the reverse proxy's
job; arr-mcp speaks plain HTTP and says so.

Note also that the container binds `0.0.0.0` by design, because it has to be
reachable across the LAN. That drops the MCP SDK's default localhost Host and
Origin validation, which is exactly why the `allowed_hosts` check exists as a
replacement. If you forward that port from your router, an MCP token is the
only thing between the internet and every credential in your stack. Do not do that.

## MCP08 Lack of Audit and Telemetry

**The risk.** Something happened, and nobody can reconstruct what.

**What arr-mcp does.**

- Every write attempt writes a row to `audit.db`, including previews, no-ops and
  refusals. There is no path from arguments to a mutation that skips the trail.
- The row is written as `attempted` **before** the service is called, and
  replaced when the call resolves. A row still reading `attempted` therefore
  means arr-mcp died mid-write.
- Outcomes are a closed set: `attempted`, `applied`, `dry_run`, `denied`,
  `unconfirmed`, `failed`. A refusal is as much a recorded event as a write.
- Each row names the credential that made the call: `oauth:<client id>` for an OAuth
  token, or `bearer:<name>#<fingerprint>` for a named MCP token (the fingerprint is the
  first 8 hex characters of its stored hash). Bare `bearer` appears only on rows
  from before named tokens. With two clients holding two tokens, the trail can
  say which one deleted something. A blank means the row predates the column.
- The database lives in the mounted config volume, so it survives
  `docker compose down`.
- Logs go to stdout unconditionally and to a SQLite ring buffer behind the
  config UI's log pages.

**What it does not solve.** There is no external log shipping, no syslog target
and no SIEM export. `audit.db` is ordinary SQLite, which is the integration
point if you want one. Read-only calls are not audited, only logged.

## MCP09 Shadow MCP Servers

**The risk.** Unapproved servers running outside anyone's governance. This is
mostly an organisational problem rather than a property of a server.

What is relevant here: arr-mcp is deliberately **one server for the whole stack**
rather than one per service, so there is less to lose track of. The
published image carries the `io.modelcontextprotocol.server.name` label, and the
MCP Registry refuses to publish unless that label matches the server name it is
claiming, so a lookalike image cannot claim this identity. `/healthz` reports the
name and version without authentication, so you can identify what is actually
running on a port.

## MCP10 Context Injection and Over-Sharing

**The risk.** Data from one task, user or session leaking into another, or a
single answer dumping far more than was asked for.

**What arr-mcp does.**

- A fresh MCP server instance is built per request, and configuration is read
  from the runtime per request rather than captured at startup. There is no
  per-caller session state to leak between calls; what does outlive a request is
  impersonal: the response caches, the spent-token set and the audit database.
- The identity gate (see MCP02) covers the user-scoped case, and a refused
  request cannot be influenced by what the service would say.
- Reads are windowed: `limit` defaults to 50 with a hard maximum of 500, paired
  with `offset`.
- Tools return shaped fields chosen per tool rather than raw service payloads,
  which keeps disk paths and internal ids out of answers that had no use for
  them.

**What it does not solve.** Everything the configured token can reach, the model
can read. There is no per-caller data scoping, because there is only one caller.
If you do not want a model to see a library, do not configure that instance.

## What this page does not cover

- **Multi-tenancy.** One `config.yaml`, one permission set. An OAuth token can
  narrow what a caller reaches, but never grant a second set of permissions
  beside it. If different people need different service access, run several
  instances.
- **Internet exposure.** Not designed for, rather than hardened for.
- **The services themselves.** If your Radarr is reachable without an API key,
  nothing here helps.
- **Your client.** arr-mcp cannot tell whether a call originated with a person or
  with an agent acting on a poisoned web page. The permission tiers, the confirm
  handshake and the audit trail assume it never can.

## Sources

- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/), v0.1 beta
- ["Exposed by Design", arXiv 2608.00150](https://arxiv.org/abs/2608.00150), July 2026
- [The Model Context Protocol reaches a security inflection point](https://forkast.news/the-model-context-protocol-reaches-a-security-inflection-point/), Forkast, August 2026
