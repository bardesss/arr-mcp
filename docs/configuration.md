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

All ten service ids: `radarr`, `sonarr`, `prowlarr`, `bazarr`, `jellyfin`,
`seerr`, `sabnzbd`, `transmission`, `qbittorrent`, `plex`. Configure only what you run —
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
    default_user: "you"    # optional, same reasoning as Jellyfin's above
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

Read-only: there is no Plex `set_watched` and no library-scan trigger, only
reads.

**Only one media server.** `jellyfin` and `plex` cannot both be configured —
`get_library`'s per-user join needs exactly one counterparty, and the schema
refuses a config that sets both.

## Several Radarrs, Sonarrs or Bazarrs

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

Only Radarr, Sonarr and Bazarr take a list. The other five are one each:
Prowlarr feeds every *arr from one place, Seerr connects to your instances
itself, and a second download client is a different kind of setup from a quality
tier.

## Access

```yaml
auth:
  username: admin
  password_hash: "…"         # scrypt; written by the setup page, never by you
  allowed_hosts: []          # empty accepts any Host — right for a LAN container
  allow_token_in_url: false  # accept ?token=… when no Authorization header is sent
```

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

### `allow_token_in_url`

Some MCP clients can only be given a URL — no headers, no token field. With this
on, `/mcp?token=<bearer token>` authenticates the same as the header does.

An `Authorization: Bearer` header still wins whenever one is sent, right or
wrong, so turning this on cannot rescue a client that is sending the wrong
token — it fails, which is what you want.

The cost is that the token travels in the address, so a reverse proxy's access
log, a browser history or a shell history will hold a working credential. Nothing
in arr-mcp logs a URL, but everything in front of it might. Rotate the token from
the config UI if one leaks.

**This does not make Home Assistant work on its own.** Its MCP client
integration also speaks only the older HTTP+SSE transport, and this server
serves Streamable HTTP, so that setup still needs a proxy to bridge the
transport.

### `allow_other_users`

On Jellyfin and Seerr, one admin-scoped API key can answer for anybody, so
`allow_other_users` decides whether this server will deal in anyone's data but
`default_user`'s. It governs reading — whose watch state, whose requests — and
also whether `respond_to_request` and `delete_request` may act on a request
somebody else made. It defaults to `false`.

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

**The one case this cannot fix** is an `auth` block that is itself unreadable —
a mangled `bearer_token`, or `auth:` set to something that is not a mapping.
There is then no password to check, and offering the setup page instead would
let anyone who can reach the port take the instance over by corrupting its
config. The page shows the error and nothing else, and accepts no POST on any
path. Edit `config.yaml` directly and restart.

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
