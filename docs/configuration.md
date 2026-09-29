# Configuration

Everything the [config UI](config-ui.md) does is just `config.yaml`, kept in the
volume you mounted at `/config`. Editing it by hand remains supported — it needs
a restart, because nothing is watching the file. The UI applies changes
immediately, because it knows it just wrote.

```yaml
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: "…"
  jellyfin:
    url: http://192.168.1.20:8096
    api_key: "…"
    default_user: "you"      # optional, but the per-user tools want it — see below
  transmission:
    url: http://192.168.1.20:9091
    username: "…"            # neither torrent client has an API key
    password: "…"
  qbittorrent:
    url: http://192.168.1.20:8081
    username: "…"
    password: "…"
```

All twelve service ids: `radarr`, `sonarr`, `whisparr`, `prowlarr`, `bazarr`, `jellyfin`,
`seerr`, `sabnzbd`, `transmission`, `qbittorrent`, `plex`, `profilarr`. Configure only what you run —
anything you leave out is simply absent, not broken. Running both torrent
clients at once is supported; their queues merge, each item labelled with the
client it came from.

A misspelled key, an unknown service, or an `api_key` on a torrent client
**fails at startup with the offending field named**, rather than being silently
ignored.

Both credential fields are optional on either client: Transmission's RPC is
often unauthenticated on a LAN, and qBittorrent can bypass authentication for
localhost. Leave them out and nothing logs in.

Each service also takes an optional `permissions` block. Both flags default to
false, so the config above is read-only — see [writes](writes.md).

## Services behind a URL base

If a service runs under a subpath — the arr apps call it "URL Base", and it is
the usual arrangement behind one reverse proxy fronting the whole stack — put
that path in `url` and nothing else is needed:

```yaml
services:
  bazarr:
    url: http://192.168.1.20:6767/bazarr
    api_key: "…"
```

Requests are sent to `…/bazarr/api/…`. Give the URL exactly as you would type it
in a browser; a trailing slash makes no difference.

If the proxy asks for a username and password, put them in the URL:
`http://user:pass@192.168.1.20:6767/bazarr`. They go out as a Basic
`Authorization` header, not in the address. Services that send their own
`Authorization` header (Jellyfin, and Transmission with a username set) keep
theirs, so this can't stack with those. Percent-encode `@`, `:` or `%` itself
(as `%25`) in either part.

A service that redirects to a different host, or to another port or scheme, is
refused with a message naming where it points. Set `url` to that address.

## Jellyfin and `default_user`

`get_library`, `get_media_details` (its title-query form) and `diagnose` all
join Radarr/Sonarr against Jellyfin's per-user watch state. A user that does
not exist in Jellyfin, or one that is refused, fails those tools outright,
naming `default_user` and how to fix it, rather than silently answering as if
Jellyfin were not there.

Omitting `default_user` is supported — the service still appears in
`stack_health`. `get_library` then returns the Radarr and Sonarr halves with
Jellyfin marked degraded and a note naming the key, rather than failing the
whole read.

Leaving `jellyfin` out of `config.yaml` entirely is still fine — those tools
just work from Radarr and Sonarr alone.

## Plex

```yaml
services:
  plex:
    url: http://192.168.1.20:32400
    api_key: "…"           # your server's X-Plex-Token — see below
    default_user: "you"    # optional — must match the account name Plex reports
```

The `api_key` field carries Plex's own `X-Plex-Token`. The name comes from the
schema this shares with every other service, not from Plex's vocabulary — worth
knowing before you go looking for a field called `token` while editing the file
by hand. [Plex's own support article on finding an authentication
token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
covers where to get it; it is a token for your own server, not a plex.tv
sign-in.

arr-mcp only ever talks to the server at `url`. It never contacts plex.tv, and
the token is presented directly to that server — the same LAN-only reasoning
every other service here follows.

`trigger_scan` refreshes every Plex library, the same `safe` tier as a
Jellyfin scan. There is no Plex `set_watched`.

`fix_metadata` can repair Plex metadata, but only once you opt in:

```yaml
services:
  plex:
    allow_metadata_repair: true   # default false
    permissions:
      destructive: true
```

It is off by default because it has not been verified against a live Plex
server yet. Jellyfin needs no such setting, and `allow_metadata_repair` on any
other service is refused at startup. The Plex card on the config page has a
checkbox for it, marked experimental. See
[Repairing on Plex](tools.md#repairing-on-plex).

`default_user` behaves differently here than on Jellyfin, and it is worth
knowing before you set it. A local `X-Plex-Token` is scoped to one account, so
arr-mcp asks the server for the owner's name and **matches your `default_user`
against it** rather than taking your value as the user to query. Set it to
anything else and the per-user tools fail, naming the one user they do know:

```
plex not found: no user named "you@example.com"
  — Known users: YourPlexAccount. Fix default_user in config.yaml.
```

That error is the fastest way to learn what to write. The value is used
verbatim only when the server declines to name the owner at all, which some
setups do — a reverse proxy in front of `/accounts`, or a token without the
scope to read it. In that case arr-mcp trusts what you configured, says so once
in the log, and carries on.

**Only one media server.** `jellyfin` and `plex` cannot both be configured —
`get_library`'s per-user join needs exactly one counterparty, and the schema
refuses a config that sets both.

## Profilarr

```yaml
services:
  profilarr:
    url: http://192.168.1.20:6868
    api_key: "…"
```

Generate the key under Settings > Security in Profilarr. Single instance
only — see [below](#several-instances-of-one-service) for why. Powers the
drift half of `get_profile_issues` and `sync_database`, the only tool that
needs it configured to run at all. Leaving it out is fine — `get_profile_issues`
still reports its other five finding kinds, with a `note` saying drift was
not checked.

## Several instances of one service

Running an HD and a 4K Radarr side by side is a common setup, and arr-mcp reads
both. Give each one a name:

```yaml
services:
  radarr:
    - name: hd
      url: http://192.168.1.20:7878
      api_key: "…"
    - name: 4k
      url: http://192.168.1.20:7879
      api_key: "…"
  bazarr:                    # one per stack — Bazarr takes a single *arr of each
    - name: hd
      url: http://192.168.1.20:6767
      api_key: "…"
    - name: 4k
      url: http://192.168.1.20:6768
      api_key: "…"
  sonarr:                    # one instance needs no name and no list
    url: http://192.168.1.20:8989
    api_key: "…"
```

**Reads span every instance.** `stack_health` reports each separately, and a
library question answers from all of them at once — which is the whole point of
running a second one. Every row says which instance it came from, as
`radarr/4k`.

**Writes name one.** Adding a film with two Radarrs configured and no `instance`
is refused, and the refusal lists the names rather than guessing — a 4K release
landing in the HD instance is only discovered once the download has finished.
That means **adding a second instance changes how existing prompts behave**:
requests that used to be unambiguous start asking which instance you meant. It
is deliberate, and it only affects writes.

**Permissions are per instance**, so `safe_write` on `hd` and nothing on `4k` is
a configuration you can express — each entry carries its own `permissions`
block.

**Five services stay single.** Jellyfin and Plex because, as explained above,
`get_library`'s per-user join needs exactly one counterparty. Seerr because a
request carries the identity of the person who made it, and a second Seerr makes
"which one do I ask" a guess with an approver on the other end of it. Whisparr
because the one deployment that wants two is V2 beside V3 (Eros), and Eros is a
different API with no adapter. Profilarr because it is the one place that owns
profile config, so two of them would mean two sources of truth.

Everything else takes a list: Radarr, Sonarr, Bazarr, Prowlarr, SABnzbd,
Transmission and qBittorrent.

Two download clients, one behind a VPN and one not:

```yaml
services:
  qbittorrent:
    - name: vpn
      url: http://192.168.1.20:8081
      username: admin
      password: "…"
    - name: direct
      url: http://192.168.1.20:8082
```

`get_queue` reports both, each row saying which client it came from as
`qbittorrent/vpn`. `pause_downloads` needs `instance` to say which one to stop —
with two configured, omitting it is refused rather than guessed.

**Two Prowlarrs with overlapping indexers return the same release twice.**
`search_media` fans out across every configured Prowlarr and labels each row
with the instance it came from, so a release both of them index comes back once
per instance. That is the intended behaviour rather than a bug — de-duplicating
would mean deciding which instance's copy to discard, and the two may differ in
priority or in what they will actually grab — but it is worth knowing before
you set up a public plus private split and wonder why the list looks doubled.

## Access

```yaml
auth:
  username: admin
  password_hash: "…"         # scrypt; written by the setup page, never by you
  allowed_hosts: []          # empty accepts any Host — right for a LAN container
  tokens:                    # named MCP tokens; see MCP tokens below
    - name: claude-desktop
      tier: destructive
      hash: sha256:9f2c…
  allow_token_in_url: false  # accept ?token=… when no Authorization header is sent
```

A misspelled or leftover key anywhere in this block — including inside
`auth.oauth` below — **fails at startup with the offending field named**,
rather than being silently ignored, so a config that loaded on an earlier
release can stop loading after an upgrade. The server does not go down over
it: it drops into repair mode, covered under [When config.yaml will not
load](#when-configyaml-will-not-load), where the editor is reachable once you
sign in.

Sign-in is a username and password you choose the first time you open the UI.
Only a scrypt hash is stored, so the password cannot be recovered — but it can
be replaced: delete the `password_hash` line and restart, and the setup page
comes back exactly as it does on a fresh install. An instance with no
`password_hash` is *unclaimed*, and every page redirects to setup until someone
claims it.

`allowed_hosts` applies at once when saved from the UI, so **a wrong hostname
locks you out of the page you would fix it from.** Recover by editing
`config.yaml` by hand and restarting. A literal IPv6 address is written with its
brackets — `"[fd00::1]"` — and matches with or without a port.

### MCP tokens

Every client that connects to `/mcp` presents a named token. Tokens are created
on the config page, under MCP tokens: pick a name, a tier and an expiry, and
the token is shown once, with a copy button. Only its SHA-256 hash is stored, so
it cannot be read back, only revoked. A fresh install has none, so every MCP
request is refused until you create the first one.

```yaml
auth:
  tokens:
    - name: claude-desktop
      tier: destructive
      hash: sha256:9f2c…
    - name: phone-assistant
      tier: read
      hash: sha256:41ab…
      expires: 2026-12-28
    - name: ci
      tier: read
      token: <plaintext, at least 32 characters, written by hand>
```

Each entry has a unique `name`, a `tier`, and exactly one of `hash` or `token`.

**Tiers** cap what a token's client may do. `read` allows no writes, `write`
allows the safe writes, and `destructive` allows those and the destructive ones.
The tier sits on top of each instance's `permissions`, so it narrows what the
file allows and never widens it. A refused write names the token and the tier it
would need. A tier cannot be edited: create a new token and revoke the old one.

**Expiry** is optional. The create form offers 30 days, 90 days (the default) or
never; by hand, write `expires: YYYY-MM-DD`. The token stops working at the
start of that day, UTC, and requests with it get a 401 saying which token
expired and when. The dashboard warns while less than 7 days remain and switches
to "expired" on the expiry date, and an expired token stays listed, marked
expired, until you revoke it. A token cannot be extended: renew by creating a
new one, then revoking the old one.

**Hand-written tokens.** A `token:` entry needs at least 32 characters; a shorter
one fails config load. On the next start arr-mcp replaces it with its hash. If
the file is read-only, the token keeps working from memory, but a warning is
logged at every start and shown on the dashboard until the plaintext is gone. If
`config.yaml` lives in git, the plaintext stays in its history.

**Upgrading from `bearer_token`.** Your existing token becomes a token named
`default` with the `destructive` tier, so clients keep working, and the file is
rewritten to hold its hash. The dashboard no longer shows it. Backups made before
the upgrade still hold the plaintext; if that matters, create a new token, move
your clients to it, and revoke `default`.

**Downgrading.** Older versions do not know `tokens:` and open the repair page
instead of starting. The old token value cannot be recovered, since only its
hash remains, so remove `tokens:` and write a new `bearer_token` of 64 hex
characters.

### `auth.management_key`

The key for the [management API](api.md). Without it, `/api/v1` answers 404.

```yaml
auth:
  management_key:
    hash: sha256:9f2c…
    created: 2026-09-29
```

Only the hash is stored, and there is no plaintext form to write by hand. Create
the key on the config page, where it is shown once. Deleting the block turns the
API off.

### `allow_token_in_url`

Some MCP clients can only be given a URL — no headers, no token field. With this
on, `/mcp?token=<MCP token>` authenticates the same as the header does.

An `Authorization: Bearer` header still wins whenever one is sent, right or
wrong, so turning this on cannot rescue a client that is sending the wrong
token — it fails, which is what you want.

The cost is that the token travels in the address, so a reverse proxy's access
log, a browser history or a shell history will hold a working credential. Nothing
in arr-mcp logs a URL, but everything in front of it might. If one leaks, revoke that
token and create a new one.

**This does not make Home Assistant work on its own.** Its MCP client
integration also speaks only the older HTTP+SSE transport, and this server
serves Streamable HTTP, so that setup still needs a proxy to bridge the
transport.

### `auth.oauth`

Lets an MCP client authenticate with a short-lived OAuth 2.1 access token
instead of an MCP token — useful
once you have more than one client and want to hand out credentials that
expire and that carry less than full access.

**arr-mcp is only the resource server here.** It does not issue tokens, does
not run an authorization server, and does not discover one — you need an
OAuth 2.1 or OIDC provider already minting tokens before this does anything.
Set it on the **OAuth** card of the config page, which applies without a
restart. Its **Test** button fetches `jwks_uri` as typed, without saving, and
lists each key's `kid` and algorithm, flagging any key arr-mcp will not verify
with (a symmetric `oct` key, an encryption key, or an algorithm outside the
asymmetric ones it accepts). It fetches the way the verifier does: a redirect is
not followed, so the result names where it points for you to use instead, and
anything but a `200` is a failure. A failure says whether the address was
unreachable, answered an HTTP error, sent more than 1 MiB, or returned something
other than a key set. Adding the block to
`config.yaml` by hand still works, followed by a restart like any other hand
edit.

```yaml
auth:
  oauth:
    issuer: https://issuer.example.com               # https, or http on localhost/127.0.0.1
    audience: arr-mcp                                 # required — see below
    jwks_uri: https://issuer.example.com/jwks.json    # required — see below
    scopes:                                           # renameable; defaults shown
      read: arr-mcp:read
      write: arr-mcp:write
      destructive: arr-mcp:destructive
```

Absent means off, exactly like a service nobody configured.

To turn it on: give your authorization server an audience (or resource
identifier) for arr-mcp — any string, it just has to match `audience` below
exactly — and point `jwks_uri` at wherever that server publishes its signing
keys. There is no OIDC discovery in this version, so `jwks_uri` has to be
given directly rather than derived from `issuer`.

`audience` is required too. Without it, every token that issuer ever minted
for any of its clients — not just this server's — would be accepted here.

Each scope your authorization server can grant maps to one access level:

| Scope | Grants |
| --- | --- |
| `arr-mcp:read` | Read tools |
| `arr-mcp:write` | The `safe` tier, where `config.yaml` permits it |
| `arr-mcp:destructive` | The `destructive` tier, where `config.yaml` permits it |

The defaults above work as-is if your authorization server can mint scopes
with those exact names. `scopes:` renames the three strings it must grant
instead; it changes the names, never the mapping to the tiers above — use it
when your provider already has its own naming convention.

They are independent and unioned, not a ladder: `arr-mcp:destructive` carries
the `safe` tier with it, the same as `destructive: true` grants `safe_write`
below — a credential that may delete a film but not re-monitor it describes
no coherent policy. A token carrying none of the three is refused with
`403 insufficient_scope`, never silently downgraded to read.

Any of the three scopes grants the read tools; there is no separate read
gate. Every write resolves its target by reading first, so a write-scoped
token that could not read could not preview anything either.

`config.yaml` stays the sole authority throughout — a scope only narrows what
the file already permits, never widens it. A token carrying
`arr-mcp:destructive` against an instance with `destructive: false` is still
refused, by the same gate that refuses an MCP token.

Both `auth` and this block are validated strictly, so a misspelled key
anywhere inside it fails at startup with the offending field named, rather
than being silently dropped.

`allow_token_in_url` cannot be set while `oauth` is configured — refused at
config load, and disabled in the config UI with a line explaining why.

Configuring this block also changes what a credential-less client sees on its
first request: instead of a 401 telling it to go configure a token, it now
runs the full OAuth discovery-and-authorize flow and still ends up 401,
without that message.

**Checking it worked.** Once the container is back up,
`curl http://<host>:6060/.well-known/oauth-protected-resource` should return a
JSON document naming your `issuer` under `authorization_servers`. A client
that implements RFC 9728 discovery finds this on its own, from the
`resource_metadata` the 401 challenge on `/mcp` points at; one that does not
can still be handed a token directly, exactly as it would an MCP
token, as `Authorization: Bearer <token>`.

If a client's token is refused, the status code says why:

| Status | Cause | Fix |
| --- | --- | --- |
| `401` | Bad signature, wrong `issuer` or `audience`, missing or expired `exp` | Check the token was minted for this `audience`, by this `issuer`, and has not expired |
| `403 insufficient_scope` | The token carries none of the three scopes | Grant it at least one of `arr-mcp:read`, `arr-mcp:write` or `arr-mcp:destructive` (or your renamed equivalents) |
| `503` | arr-mcp could not fetch `jwks_uri` | Check the issuer is reachable from the container, not from your browser |

A `503` is not a rejection of the token itself — it means arr-mcp could not
check it. Retrying once the issuer is reachable again works with no other
change. The exception is a token whose own `exp` has already passed: that
still gets a `401` during an outage, because no retry would help it.

### `allow_other_users`

On Jellyfin and Seerr, one admin-scoped API key can answer for anybody, so
`allow_other_users` decides whether this server will deal in anyone's data but
`default_user`'s. It governs reading — whose watch state, whose requests — and
also whether `respond_to_request` and `delete_request` may act on a request
somebody else made. It defaults to `false`.

Plex has no equivalent: a Plex token is scoped to one account, so there is no
second user to permit. `services.plex.allow_other_users: true` is refused at
config load rather than accepted and ignored.

### Editing `config.yaml` by hand

Supported, and the comments you write in it are preserved when the config UI
saves over it. One caveat: if you edit the file while the config page is open,
the next save from that page is **refused** rather than applied, because it was
assembled from a snapshot taken before your edit. Reload the page and make the
change again.

## When config.yaml will not load

A typo used to take the container down: the process failed to start, Docker
restarted it, and the config UI — the thing that could have fixed it — never
came up.

Now it starts in repair mode instead. The page at `http://<host>:6060` shows the
validation error and the file in a text box. Fix it, save, and the server starts
normally without a restart. There is no MCP endpoint and no services until then;
`/mcp` answers `503` and `/healthz` reports `degraded` with a `200` status, so a
container healthcheck built on `/healthz` does not restart-loop the very process
that would fix it.

Sign-in works as usual. If nobody has claimed the instance yet, you claim it
first, exactly as on a fresh install.

**The one case this cannot fix** is a file whose sign-in fields cannot be read:
YAML that does not parse, a top level or an `auth:` that is not a mapping, or a
`username`, `password_hash`, `allowed_hosts` or `allow_token_in_url` of the
wrong type (an empty `username` or `password_hash` counts). There is then no
password to check, and offering the setup page instead would let anyone who can
reach the port take the instance over by corrupting its config. The page shows
the error and nothing else, and accepts no POST on any path. Edit `config.yaml`
directly and restart. A mistake in `tokens`, `bearer_token` or `oauth` does not
count: those go to the repair page like any other invalid config.

This page shows the file exactly as it is on disk, including every API key. See
[Security](security.md#the-repair-page-renders-the-config-file-verbatim).

## The IMDb dataset

```yaml
metadata:
  imdb:
    enabled: true
```

Off by default. It is the only source of an IMDb rating for a TV series, and a
fallback for everything else — see [IMDb ratings](imdb.md) for what it costs and
whether you need it.

## Appearance

```yaml
ui:
  theme: dark   # system (default) · dark · light
```

`system` follows the browser's `prefers-color-scheme` and tracks your OS as it
changes; the other two override it. Omit the block entirely for `system` —
choosing it on the Configuration page removes the block rather than writing it
out, so a config nobody customised stays as clean as it started.

It is stored server-side rather than in the browser because this UI has exactly
one account: there is no second person for a shared setting to be wrong for, and
it holds wherever you sign in from.
