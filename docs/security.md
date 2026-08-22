# Security

What arr-mcp does about the risks specific to running an MCP server, what it
deliberately does not do, and where the boundary sits.

The structure follows the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
(v0.1, beta) because it is the only shared vocabulary for this that currently
exists. Each risk gets the same three answers: what it is, what this server does
about it, and what it still does not solve. The third one is the reason the page
is worth reading.

To report something, see [SECURITY.md](../SECURITY.md).

## The threat model first

arr-mcp is a **single-operator LAN appliance**. One person configures it, one
bearer token reaches it, one set of permissions applies. It is not multi-tenant,
it does not federate, and it is
[not designed to be exposed to the internet](../README.md#security).

Within that, two questions are separate and both matter:

| Question | Answered by |
| --- | --- |
| Who may reach this server at all? | Bearer token, config UI password, `allowed_hosts` |
| What may a caller do once it is in? | Permission tiers, the confirm handshake, the audit trail |

Most published MCP security work stops at the first question. Recent scanning
research is a good example: ["Exposed by Design"](https://arxiv.org/abs/2608.00150)
(July 2026) audited 640 production servers and found 91.8% without OAuth and 687
instances with unrestricted shell tool access — entirely a statement about the
first row. arr-mcp answers the first row with a mandatory bearer token rather
than OAuth, and spends most of its design effort on the second.

The second row is where the interesting failure is. An authenticated caller is
not automatically a trustworthy one, because the caller is a language model
acting on text it read somewhere else.

## MCP01 Token Mismanagement and Secret Exposure

**The risk.** Credentials in logs, in model context, in debug traces, in the
transcript. This server holds every service credential you configure plus its own bearer
token, so it is a concentrated target.

**What arr-mcp does.**

- Credentials live in `config.yaml` in the mounted config volume. No tool
  returns one, and no tool takes one as an argument.
- Upstream errors carry the **origin and path only**, never the full URL
  (`src/core/http.ts`). SABnzbd authenticates by query parameter, so a logged
  full URL would be a logged API key.
- `get_stack_health` is the one place a service URL leaves the process, and it
  strips any `user:pass@` userinfo on the way out — `withoutCredentials` in
  `src/tools/stackHealth.ts`.
- Audit arguments pass through a key-name redactor before they are written, even
  though no write tool accepts a credential today (`src/core/audit.ts`). That
  keeps it true by construction rather than by everyone remembering.
- The config UI password is stored as a scrypt hash and nothing else. The bearer
  token is 32 random bytes, and rotating it from the UI takes effect on the very
  next request rather than at the next restart.
- The maintenance scripts redact configured hostnames from their output, with a
  test that says so (`test/scriptsRedact.test.ts`).

**What it does not solve.** `config.yaml` is plaintext on disk. There is no
secret manager integration and no encryption at rest, so filesystem permissions
on the config volume are the real boundary. And
[`allow_token_in_url`](configuration.md#allow_token_in_url) puts the bearer
token in the address when you turn it on, which a reverse proxy access log will
happily record — it is off by default, and the cost is documented where it is
enabled.

## MCP02 Privilege Escalation via Scope Creep

**The risk.** Permissions granted once, broadly, and never narrowed. The agent
ends up able to do more than anyone consciously decided.

**What arr-mcp does.**

- Two ordered tiers, `safe_write` and `destructive`, both defaulting to false,
  on **every service** — including the ones added by hand-editing YAML. See
  [Writes](writes.md#permissions).
- Permissions are **per instance**. `radarr/hd` can be writable while
  `radarr/4k` is not.
- The gate reads configuration and nothing else (`src/core/permissions.ts`). A
  compromised or simply buggy adapter cannot widen its own permissions by
  claiming a capability it was never granted.
- The service whose permissions apply is resolved **from the tool arguments,
  before anything else runs** (`src/tools/write.ts`), so the service that is
  checked is the same one the audit row names and the confirm token binds to. A
  multi-service tool like `trigger_search` cannot check Sonarr's write against
  Radarr's permission block.
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
rather than as data. For a media stack this is not hypothetical: Prowlarr
returns release names from public indexers, which means attacker-controllable
strings flow straight into model context.

**What arr-mcp does.** Every piece of free text a service returns is fenced
(`src/core/fence.ts`) before it reaches the model:

- Wrapped in a labelled boundary that names its source, so injected text is
  visibly data with a provenance attached.
- The value's own angle brackets are escaped first, so a release name cannot
  close the fence and continue outside it. A fence a value can escape is worse
  than no fence, because it looks like protection.
- C0 and C1 control characters, zero-width characters, and the bidirectional
  override and isolate ranges are stripped. U+202E is the one that matters most:
  it makes the rest of a string render right to left, so a release name can
  display as something completely different from the bytes a human later reads
  in an audit log.
- Truncated at 2000 characters, so a single hostile overview cannot crowd out
  everything else in the answer.
- Escaped rather than censored — the words survive verbatim, so the model can
  still read what the indexer actually said.

Tool definitions themselves are static and registered in-process. Nothing
fetches a tool description from a remote source, so there is no rug-pull surface
where a tool's description changes after you approved it.

**What it does not solve.** Fencing does not make prompt injection impossible.
It makes injected text *visibly* data and removes the characters that let a
string render as something other than what it is. A model that decides to obey
fenced text anyway is not something this server can prevent — which is precisely
why the write path has a second line of defence. See MCP06.

## MCP04 Software Supply Chain and Dependency Tampering

**The risk.** A compromised dependency or a tampered image changes what the
server does without any change to its source.

**What arr-mcp does.**

- Eight runtime dependencies. Every addition is a deliberate decision, and the
  audit database reuses the SQLite driver the log buffer already needed rather
  than adding a second one.
- Renovate groups non-major updates into one monthly PR, because a solo
  maintainer reviewing eight separate patch bumps is eight chances to
  rubber-stamp one. Vulnerability alerts are exempt and run at any time.
- Images are built with an SBOM and `provenance: mode=max`, and the pushed
  digest is attested with `actions/attest-build-provenance`, so you can verify
  that the image you pulled came from this repository's workflow.
- The MCP Registry publisher binary is pinned and SHA256-verified rather than
  curled from `releases/latest`.
- `npm ci` from a committed lockfile, everywhere, including inside the image
  build.
- `test/dockerGlibc.test.ts` compares the glibc symbols the shipped
  `better-sqlite3` prebuilds actually import against the Debian suite the
  Dockerfile names. This exists because a prebuild once outgrew the base image
  and broke arm64 at startup while amd64 stayed green.

**What it does not solve.** There is no dependency pinning by hash beyond the
lockfile, and no reproducible-build guarantee. Provenance tells you where the
image was built, not that its inputs were uncompromised.

## MCP05 Command Injection and Execution

**The risk.** The category that produced the 687 unrestricted-shell instances in
the scanning research above.

**What arr-mcp does.** There is no shell tool, no `exec`, and no
`child_process` import anywhere in `src/`. That entire risk class does not have
a foothold here.

Outbound requests all go through one HTTP client against a base URL the operator
configured. Paths are **prefixed, not resolved** (`src/core/http.ts`), so an
adapter path cannot escape a service's URL base. Configured URLs must be
`http://` or `https://`, validated at startup. No tool accepts a URL or a
hostname as an argument, so no model-controlled string decides a network
destination.

The one path-shaped argument is `add_media`'s `root_folder`, and it is a
**selection, not a value**: the string is matched against the root folders that
service already has configured, and anything matching none of them is refused
with the available list rather than passed through — `chooseOne` in
`src/tools/addMedia.ts`. The same is true of quality profiles. A model cannot
name a directory into existence.

**What it does not solve.** Nothing structural outstanding here. This is the one
row where the honest answer is that the risk was designed out rather than
mitigated.

## MCP06 Intent Flow Subversion

**The risk.** Instructions embedded in context steer the agent away from what
the user actually asked for. This is the risk MCP03 turns into when the model
does obey the injected text.

**What arr-mcp does.** This is what the confirm handshake exists for
(`src/core/confirm.ts`, and [Writes](writes.md) for the user-facing version).

A write tool called without `confirm` performs nothing. It returns a preview
plus a token, and only a second call carrying that token mutates anything.

- The token is an **HMAC over the exact operation**: tool, service, tier,
  operation, resolved target, and every effect-bearing argument. A token issued
  for "delete movie 5" cannot be replayed as "delete movie 9". Without that
  binding a model could preview something harmless and confirm something else —
  worse than no confirmation, because it would look like protection.
- It binds to the **resolved id, not the phrase the user typed**, so a token
  cannot survive re-resolving a title to a different film.
- **Single-use**, so "add movie" cannot be confirmed twice into a duplicate.
- **Five-minute TTL**, so a token found in an old transcript is dead.
- The signing key is fresh per process and never written down. A restart
  invalidating outstanding tokens is the correct behaviour.
- Expiry is checked before the signature so an old token reports "expired"
  rather than a misleading "mismatch"; the spent-token check happens after the
  signature, so an unsigned guess cannot probe which tokens have been used.
- `dry_run` is a terminal preview that never issues a token and is never refused
  by the permission tier, so "what would this do, and what would I need to
  enable for it" stays answerable without granting anything.

**What it does not solve.** State this plainly: the handshake does not stop a
determined model, which holds the token and can simply call twice. What it
guarantees is that the **first** call cannot mutate anything, so a mis-parsed
instruction surfaces as a preview a human can see and an audit row that exists
either way. The control is visibility before the fact, not impossibility.

## MCP07 Insufficient Authentication and Authorization

**The risk.** Servers that verify nothing, which is the majority in every survey
so far.

**What arr-mcp does.**

- `/mcp` requires a bearer token. There is no unauthenticated mode and no
  "trusted network" bypass, because "LAN-only" is a network assumption rather
  than a security control, and a home network contains guest phones and IoT
  devices.
- The token is read from the runtime on **every request**, so rotating it takes
  effect immediately rather than at the next restart.
- The config UI has its own scrypt-hashed password with a 12 character minimum
  and a signed, expiring session cookie (12 hours). It is a bigger target than
  the MCP endpoint, because it displays every service's API key and can change
  them.
- Sessions end when you end them: signing out revokes that token, and changing
  the password revokes every session issued before it. Neither waits for the
  cookie to expire or for a restart.
- `allowed_hosts` is validated per request rather than frozen at startup, for
  the same reason: a security setting that appears to have applied when it has
  not is the worst kind.

**What it does not solve.** There is no OAuth, no per-client identity, and no
scoping of one token differently from another. One operator, one token. TLS is
the reverse proxy's job; arr-mcp speaks plain HTTP and says so.

Note also that the container binds `0.0.0.0` by design, because it has to be
reachable across the LAN. That drops the MCP SDK's default localhost Host and
Origin validation, which is exactly why the `allowed_hosts` check exists as a
replacement. If you forward that port from your router, the bearer token is the
only thing between the internet and every credential in your stack. Do not do that.

## MCP08 Lack of Audit and Telemetry

**The risk.** Something happened, and nobody can reconstruct what.

**What arr-mcp does.**

- Every write attempt writes a row to `audit.db`, including previews, no-ops and
  refusals. There is no path from arguments to a mutation that skips the trail.
- The row is written as `attempted` **before** the service is called, and
  replaced when the call resolves. A row still reading `attempted` therefore
  means arr-mcp died mid-write — precisely the case an after-the-fact-only log
  cannot show.
- Outcomes are a closed set: `attempted`, `applied`, `dry_run`, `denied`,
  `unconfirmed`, `failed`. A refusal is as much a recorded event as a write.
- The database lives in the mounted config volume, not the container filesystem.
  A trail that vanishes on `docker compose down` is not a trail.
- Logs go to stdout unconditionally and to a SQLite ring buffer behind the
  config UI's log pages, so `docker logs` still works before anyone has reached
  the UI.

**What it does not solve.** There is no external log shipping, no syslog target
and no SIEM export. `audit.db` is ordinary SQLite, which is the integration
point if you want one. Read-only calls are not audited, only logged.

## MCP09 Shadow MCP Servers

**The risk.** Unapproved servers running outside anyone's governance. This is
mostly an organisational problem rather than a property of a server, and
pretending otherwise would be dishonest.

What is relevant here: arr-mcp is deliberately **one server for the whole stack**
rather than one per service, which is one fewer thing to lose track of, and the
reason the tool count stays at twenty-four instead of multiplying by the number
of services. The
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
  deliberate and impersonal — the response caches, the spent-token set and the
  audit database.
- The identity gate covers the user-scoped case: Jellyfin and Seerr keys are
  admin-scoped, so `allow_other_users` defaults to false, and a refused request
  costs no network call and cannot be influenced by what the service would say.
- Reads are windowed. `limit` defaults to 50 with a hard maximum of 500, paired
  with `offset`, so no single answer can pour an entire library into the context
  window.
- Tools return shaped fields chosen per tool rather than raw service payloads,
  which keeps disk paths and internal ids out of answers that had no use for
  them.

**What it does not solve.** Everything the configured token can reach, the model
can read. There is no per-caller data scoping, because there is only one caller.
If you do not want a model to see a library, do not configure that instance.

## What this page does not cover

- **Multi-tenancy.** One operator, one token, one permission set. If several
  people need different access, run several instances.
- **Internet exposure.** Covered by refusing to design for it rather than by
  hardening for it.
- **The services themselves.** If your Radarr is reachable without an API key,
  nothing here helps.
- **Your client.** arr-mcp cannot tell whether a call originated with a person or
  with an agent acting on a poisoned web page. The permission tiers, the confirm
  handshake and the audit trail are what remain when that distinction is
  unavailable, and they are designed on the assumption that it always is.

## Sources

- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/), v0.1 beta
- ["Exposed by Design", arXiv 2608.00150](https://arxiv.org/abs/2608.00150), July 2026
- [The Model Context Protocol reaches a security inflection point](https://forkast.news/the-model-context-protocol-reaches-a-security-inflection-point/), Forkast, August 2026
