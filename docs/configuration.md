# Configuration

Everything the [config UI](config-ui.md) does is just `config.yaml`, kept in the
volume you mounted at `/config`. Editing it by hand is supported but needs a
restart, because nothing is watching the file. The UI applies changes
immediately.

```yaml
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: "…"
  jellyfin:
    url: http://192.168.1.20:8096
    api_key: "…"
    default_user: "you"      # optional, but the per-user tools want it; see below
  transmission:
    url: http://192.168.1.20:9091
    username: "…"            # neither torrent client has an API key
    password: "…"
  qbittorrent:
    url: http://192.168.1.20:8081
    username: "…"
    password: "…"
  nzbget:
    url: http://192.168.1.20:6789
    username: "…"            # NZBGet's ControlUsername / ControlPassword
    password: "…"
```

All nineteen service ids: `radarr`, `sonarr`, `whisparr`, `lidarr`, `prowlarr`, `bazarr`,
`jellyfin`, `seerr`, `sabnzbd`, `nzbget`, `transmission`, `qbittorrent`, `plex`,
`profilarr`, `cleanuparr`, `reclaimerr`, `dispatcharr`, `shelfmark`, `grimmory`. Configure only what you run. Running both torrent
clients at once is supported; their queues merge, each item labelled with the
client it came from.

A misspelled key, an unknown service, or an `api_key` on a torrent client or
NZBGet **fails at startup with the offending field named**, rather than being silently
ignored. That holds at the top level too since 2.0: `service:` for `services:`
starts the repair page with `Unrecognized top-level key "service" (did you mean
services?)`. Rename or remove the key.

Both credential fields are optional on either torrent client and on NZBGet:
Transmission's RPC is often unauthenticated on a LAN, qBittorrent can bypass
authentication for localhost, and NZBGet runs without a login when its control
password is empty. Leave them out and nothing logs in.

Each service also takes an optional `permissions` block. Both flags default to
false, so the config above is read-only; see [writes](writes.md).

Each service also takes an optional `timeout_ms`: how long one request to it may
take before it counts as timed out, in milliseconds, default `10000`. A read
that times out is retried once. A few calls known to be slow on a healthy stack,
an interactive release search and a metadata repair, carry their own longer
limit and ignore this one.

## Secrets from files or the environment

A service's `api_key` or `password` can stay out of `config.yaml`. Name a file
with `api_key_file` or `password_file`, the way Docker, Podman and systemd
secrets are mounted, or write the whole value as `${NAME}` to read environment
variable `NAME`:

```yaml
services:
  radarr:
    url: http://radarr:7878
    api_key_file: /run/secrets/radarr_api_key
  sabnzbd:
    url: http://sabnzbd:8080
    api_key: ${SABNZBD_API_KEY}
  qbittorrent:
    url: http://qbittorrent:8081
    username: admin
    password_file: /run/secrets/qbittorrent_password
```

- A file is read as it is, minus one trailing newline.
- `${NAME}` has to be the whole value. `abc${NAME}` is the literal key
  `abc${NAME}`.
- Setting both `api_key` and `api_key_file` is an error.
- References are written in `config.yaml` only. The config UI and the
  management API refuse a `${NAME}` typed as a key or password, since that
  would let anyone using them read the server's environment.
- A file that is missing, unreadable or empty, or a variable that is unset or
  empty, starts arr-mcp in [repair mode](#when-config-yaml-will-not-load) with
  the instance and field named, for example
  `services.radarr.api_key_file: the file could not be read (ENOENT)`.
- Both are read when arr-mcp starts and again whenever the config is saved. A
  changed secret file or variable takes effect on the next restart.

This covers every service credential, Plex's token included (it is the
`api_key` field). The `auth` and `webhooks` secrets are not covered yet.

The config UI shows such a field as set from file or set from environment and
never writes the secret into `config.yaml`: a save keeps the reference. It
cannot change the credential either, since the file or variable is where it
lives, and it refuses a new URL on another host for that instance, as it does
for any stored credential. Test uses the resolved value. In the
[management API](api.md) the instance shows `apiKeyFrom` or `passwordFrom`.

## Services behind a URL base

If a service runs under a subpath (the arr apps call it "URL Base"), put that
path in `url` and nothing else is needed:

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
`Authorization` header (Jellyfin, Grimmory, and Transmission with a username
set) keep theirs, so this can't stack with those. Percent-encode `@`, `:` or
`%` itself (as `%25`) in either part. The config page shows the URL without them, and
saving that URL unchanged keeps them; to change them, type a URL that has
its own `user:pass@`.

A redirect from `http` to `https` on the same host (port 443 or the same port)
is followed, as a proxy upgrading to TLS does. Any other redirect to a different
host, port or scheme is refused with a message naming where it points. Set
`url` to that address.

## Jellyfin and `default_user`

`get_library`, `get_media_details` (its title-query form) and `diagnose_media` all
join Radarr/Sonarr against Jellyfin's per-user watch state. A user that does
not exist in Jellyfin, or one that is refused, fails those tools outright,
naming `default_user` and how to fix it, rather than silently answering as if
Jellyfin were not there.

Omitting `default_user` is supported: the service still appears in
`get_stack_health`, and `get_library` returns the Radarr and Sonarr halves with
Jellyfin marked degraded and a note naming the key. Leaving `jellyfin` out
entirely is also fine; those tools then work from Radarr and Sonarr alone.

## Plex

```yaml
services:
  plex:
    url: http://192.168.1.20:32400
    api_key: "…"           # your server's X-Plex-Token; see below
    default_user: "you"    # optional: must match the account name Plex reports
```

The `api_key` field carries Plex's own `X-Plex-Token` (there is no field called
`token`). [Plex's support article on finding an authentication
token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
covers where to get it; it is a token for your own server, not a plex.tv
sign-in. arr-mcp only ever talks to the server at `url` and never contacts
plex.tv.

`trigger_scan` refreshes every Plex library, the same `safe` tier as a
Jellyfin scan. There is no Plex `set_watched`.

`fix_metadata` can repair Plex metadata. Like any destructive write it needs
`destructive`, and Plex has its own switch on top, on by default:

```yaml
services:
  plex:
    allow_metadata_repair: false   # default true; set false to keep the repair off
    permissions:
      destructive: true
```

Jellyfin needs no such setting, and `allow_metadata_repair` on any other service
is refused at startup. The Plex card
on the config page has a checkbox for it. See
[Repairing on Plex](tools.md#repairing-on-plex).

`default_user` behaves differently here than on Jellyfin. A local
`X-Plex-Token` is scoped to one account, so arr-mcp asks the server for the owner's name and **matches your `default_user`
against it** rather than taking your value as the user to query. Set it to
anything else and the per-user tools fail, naming the one user they do know:

```
plex not found: no user named "you@example.com". Known users: YourPlexAccount.
Fix default_user in config.yaml.
```

The value is used verbatim only when the server declines to name the owner (a
reverse proxy in front of `/accounts`, or a token without the scope to read
it); arr-mcp then trusts what you configured and says so once in the log.

So on Plex `default_user` is optional. Leave it out and the per-user tools use
the owner `/accounts` names. You only need it when the server won't name the
owner.

## Plex and Jellyfin together

Both can be configured. One is the primary and answers as it always has; the
other is the secondary. Say which in a top-level setting:

```yaml
primary_media_server: jellyfin   # or plex
services:
  jellyfin:
    url: http://192.168.1.20:8096
    api_key: "…"
    default_user: "you"
  plex:
    url: http://192.168.1.20:32400
    api_key: "…"
    default_user: "you"
```

`primary_media_server` is required when both are configured, and must name one
that is. With one media server configured it is not needed. The config page
sets it for you: adding the second server keeps the existing one primary.

`get_library`'s per-user join runs against the primary, so `presence`,
`playback` and `seasons` describe the primary only. The secondary adds
`media_servers`, which says per item whether it has it. See
[`get_library`](tools.md#which-media-server-has-it).

Each server keeps its own `default_user`, and the secondary is read as that
user. A Plex secondary with none is read as the token's owner. A Jellyfin
secondary with none, or either one with a `default_user` that matches nobody, is
not read, and `get_library` says so in its `note`. Jellyfin's
`allow_other_users` and Plex's `allow_metadata_repair` stay on their own blocks.

## Lidarr

```yaml
services:
  lidarr:
    url: http://192.168.1.20:8686
    api_key: "…"
```

It can be configured more than once, the way Radarr can (see
[several instances](#several-instances-of-one-service)), for example for a
lossless library beside a lossy one:

```yaml
services:
  lidarr:
    - name: flac
      url: http://lidarr-flac:8686
      api_key: "…"
    - name: mp3
      url: http://lidarr-mp3:8686
      api_key: "…"
```

Every artist row names the instance it came from in `acquisition.service`, as
`lidarr/flac`. An artist both of them hold is one row, joined on its MusicBrainz
id, and that row carries the `acquisition` of the instance whose name sorts
later (with `flac` and `mp3`, always `mp3`). The rest of that row, `acquisition.id`, `has_file`, `monitored` and a
`diagnose_media` built from it, is that one instance's too and says nothing
about the other copy, so `diagnose_media` can call an artist playable when only
one instance has its files. `get_media_details` with `instance` reads each one.

A tool that acts on one Lidarr takes `instance`, as with any service.
`arr://lidarr/monitoring` reports each instance that answered
beside the totals, and names one that did not in `degraded`; the totals add the
instances up, so an artist both hold counts in each.

A configured Lidarr connects, appears in `get_stack_health` with its version, its
disks, any failing health checks and when its library was last scanned
(`RescanFolders`, Lidarr's daily disk scan: its scheduled `RefreshArtist` skips
the disk when no metadata changed, so it is not the scan time), and lists its
**artists** in `get_library` as `kind: "artist"`, with the album count, genres,
monitoring, quality profile, file state and the artist's MusicBrainz id. One row
per artist, the way Sonarr rows on a series, not one per album.

That scan time is when a `RescanFolders` last finished, even one that failed,
which is not always a full scan of the library. A scan stops at a missing root
folder and skips an empty one, but either way it counts, so an unmounted music
share can show a scan from today; Lidarr's root-folder health check, every six
hours, reports a missing root folder that holds artists in `failures`, but not
an empty one. Adding an artist runs one for that artist's folder alone, which
also puts the daily scan off, so an import list that adds an artist every day
keeps the time recent without a full scan. A new install reports a scan time
for up to a day before one has run.

At `detail: "full"`, `get_stack_health` also lists its recent warnings and errors,
read from `/api/v1/log` and folded the way Radarr's and Sonarr's are. From
2.8.1.4482 Lidarr can turn its log database off (`LogDbEnabled`); its row in
`logs.lines` then says `logDbEnabled: false`.

An artist joins to a media server on its MusicBrainz id, and
`get_media_details` on an artist lists its albums with the id `set_monitoring`
takes; see [Music, from Lidarr](tools.md#music-from-lidarr).

`diagnose_media` walks a Lidarr artist too, by name or by Lidarr artist id; see "Lidarr
artists" under `diagnose_media` in [tools.md](tools.md). `get_media_details` asked
for an artist by title refuses it, naming `get_media_details` with
`service: "lidarr"` and `detail: "full"` as the route that holds the albums.
`fix_metadata` retags an artist's files by Lidarr id, as below.

**It is not read-only.** Two tools write two different things:

| Tool | Addresses | Writes |
| --- | --- | --- |
| `set_monitoring` with `level: "album"` | one album, by `id` from `get_media_details` | that album's own monitor flag |
| `update_media` | an artist `id`, or no `id` for every artist | `monitored`, `monitor_new_items`, or both, across those artists |

The artist flag is not the album flag: changing one leaves the other as it was.
`monitor_new_items` is the standing rule Lidarr applies to albums it discovers
later, and `none` is the only value that stops the wanted list growing by
itself. See [writes](writes.md#lidarr-the-artist-flag-is-not-the-album-flag).

`search_media` with `source: "discover"` returns Lidarr's artist lookup, and `add_media` adds an artist by
its MusicBrainz id, with a quality profile, a metadata profile (the root
folder's default when none is named), and Lidarr's own `monitor` values and
`monitor_new_items`. `update_media` changes an artist's quality profile,
metadata profile, root folder, monitoring and tags through Lidarr's Artist
Editor, which starts no refresh, so a new metadata profile applies at the
artist's next one. `delete_media` deletes a whole artist, with Lidarr's own
`deleteFiles` and `addImportListExclusion`. `fix_metadata` with
`id: "lidarr:<artistId>"` rewrites the tags inside an artist's files from
Lidarr's metadata, previewing Lidarr's own retag list, and `get_history` reads
each retagged file as `retagged`.

`trigger_scan` rescans the library or refreshes one artist (the rescan after it
still reads every root folder), renames an artist's files, and
`import_download` imports a finished download by its id; see `docs/tools.md`. Its queue, history
and blocklist read the way Radarr's and Sonarr's do, in `get_queue`,
`get_history` and `get_blocklist`, and `remove_blocklist_item` takes a Lidarr
entry, as `remove_queue_item` takes a Lidarr download.
`get_history` with `service: "lidarr"` and `id` scopes to one artist.

`get_wanted` and `get_calendar` list its albums. A wanted row is
`kind: "artist"`: `id` and `title` name the artist, and `albumId` and
`albumTitle` the album, which `set_monitoring` takes with `level: "album"`. A
calendar row is the album, with its artist beside it, and `hasFile` only once
every track is on disk. Both leave out every album of an unmonitored artist, as
Lidarr's own lists do.

`trigger_search` searches the indexers for an artist, or for albums of it named
in `albums`, and `get_releases` and `grab_release` list and grab the releases
for the artist or one `album`. `add_media` matches a tag it is given, and
`get_stack_health` lists tags at `detail: "full"`.

The version floor is 2.1.3.

`CONTRIBUTING.md` lists the endpoints that still need a capture against a library
with real activity before their row shapes are proven.

## Profilarr

```yaml
services:
  profilarr:
    url: http://192.168.1.20:6868
    api_key: "…"
```

Generate the key under Settings > Security in Profilarr. Single instance
only; see [below](#several-instances-of-one-service) for why. Powers the
drift half of `get_profile_issues` and `sync_database`, the only tool that
needs it configured to run at all. Leaving it out is fine: `get_profile_issues`
still reports its other five finding kinds, with a `note` saying drift was
not checked.

## Cleanuparr

```yaml
services:
  cleanuparr:
    url: http://192.168.1.20:11011
    api_key: "…"
```

The key is under Settings > Account > API Key in Cleanuparr. Single instance
only, because one Cleanuparr cleans one stack. Read-only: arr-mcp only ever
sends GET requests to it, and never reads its download client settings, which
hold client passwords. `permissions` are read as off whatever the file says.
Written against Cleanuparr 2.10.x and checked against 2.11.0.
A newer minor is untested, and `get_stack_health` flags it.

It covers torrent clients only. Its findings appear in `get_stack_health`, its
events in `get_history`, and `diagnose_media` uses them to explain a download it
removed. At `detail: "full"`, its seeding rules also reach `get_queue`, but
only for a client arr-mcp can match: the host and port of the download client
in Cleanuparr must equal the host and port in the matching arr-mcp client's
`url`, and the client type must be the same. A rule set that matches no client,
or that two Cleanuparr clients both point at, is left out of `get_queue` and
named in `get_stack_health`'s `seedingRules.notes`.

## Reclaimerr

```yaml
services:
  reclaimerr:
    url: http://192.168.1.20:8000
    api_key: "rcl_…"
```

`api_key` is an API token from Settings > Integrations in Reclaimerr, with the
read scopes `system:read`, `candidates:read`, `rules:read`,
`events:read` and `protections:read`. Give it nothing else: arr-mcp only sends
GET requests to Reclaimerr's versioned `/api/v1`, and `get_stack_health` warns when
the token also carries `candidates:manage`, `protections:manage` or
`tasks:run`. A token without one of the five still works for what it can read,
and `get_stack_health` names the scopes it is missing. `permissions` are read as off
whatever the file says. Single instance only, because one Reclaimerr owns one
library's cleanup rules. Written against Reclaimerr 0.6.x, with 0.6.0 as the
floor (the first with `rules:read`). A newer minor is untested,
and `get_stack_health` flags it.

Its findings and what its rules will delete appear in `get_stack_health`, a title's
cleanup state in `get_media_details`, its lifecycle events in `get_history`,
and `diagnose_media` uses them to say a file was deleted by a cleanup rule, or is
about to be. Titles are matched on their TMDB id.

## Dispatcharr

```yaml
services:
  dispatcharr:
    url: http://192.168.1.20:9191
    api_key: "…"
```

Create the key in Dispatcharr under Users: edit the user, open the API & XC
tab and generate one. A user at the Standard level is enough, and better than
an admin: Dispatcharr returns provider passwords to admin keys, and arr-mcp
needs none of them. It reads M3U accounts, EPG sources and the version, with GET
requests only, and drops every provider username, password and URL when it
parses them, so none reaches a tool result or a log line. `permissions` are
read as off whatever the file says. Single instance only, because one
Dispatcharr serves one set of playlists. If the connection test says the key
cannot read M3U accounts, check the user's level and Dispatcharr's Settings →
Network Access. Written against Dispatcharr 0.33.x; a newer minor is untested,
and `get_stack_health` flags it.

Its findings appear in `get_stack_health`: failing or overdue playlists, provider
accounts about to expire, and failing EPG sources.

## Shelfmark

```yaml
services:
  shelfmark:
    url: http://192.168.1.20:8084
    # api_key: "…"   only once authentication is on in Shelfmark
    # permissions:
    #   safe_write: true   to let grab_release queue books and retry_download retry them
    #   destructive: true  to let remove_queue_item cancel them
```

Shelfmark starts with no authentication, and then needs no key: every route is
open to anything that can reach it. Once authentication is on, what arr-mcp can
do depends on the key:

| `api_key` | `get_stack_health` | `get_queue`, `get_history`, finding, grabbing, cancelling and retrying books | Version check |
|---|---|---|---|
| None, with no authentication set up | yes | yes | yes |
| `SHELFMARK_API_KEY_READONLY` | yes | no | no |
| `SHELFMARK_API_KEY` | yes | yes | yes |

With the read-only key Shelfmark cannot search for books either, so `search_media` shows it as degraded.

Shelfmark's docs treat `SHELFMARK_API_KEY` as a root password (an admin can set
a post-download script that the server runs), so storing it here gives
arr-mcp's config file that reach. Use the read-only key if `get_stack_health` is all
you want. arr-mcp writes three things: queueing a release and retrying a download
with `safe_write` on, and cancelling a download with `destructive` on. Single instance only, because one Shelfmark holds one download
queue. Needs Shelfmark 1.5.0 or newer, the first with `/api/stats`.

## Grimmory

```yaml
services:
  grimmory:
    url: http://192.168.1.20:6061
    username: "arr-mcp"
    password: "…"
```

Grimmory has no API key. arr-mcp signs in with a username and password and keeps
the access token in memory only. Any Grimmory user works, and the first request
that needs one triggers the login. Reading books, libraries, the Bookdrop and the
version needs a user who can see the libraries; the Bookdrop also needs
`canAccessBookdrop`. A read the account is not allowed shows up in `get_stack_health`
as a notice naming it, and nothing else is affected.

An admin account is the simplest, but an admin token can do everything in
Grimmory, including creating users and deleting libraries (arr-mcp calls no
route for those). To give it less, create a user with access to
your libraries and `canAccessBookdrop`, then add the permissions for the writes you
turn on. A write is off until you grant its tier in `permissions`:

| Permission in arr-mcp | Grimmory writes it turns on | Grimmory permission for a non-admin account |
| --- | --- | --- |
| `safe_write` | `trigger_scan` (library, Bookdrop), `import_download` (a Bookdrop file), `set_watched`, `update_book` | `canManageLibrary`, `canAccessBookdrop`, `canEditMetadata` |
| `destructive` | `delete_media`, `remove_queue_item` (Bookdrop discard), `fix_metadata` | `canDeleteBook`, `canAccessBookdrop`, `canEditMetadata` |

Read status is set for the account arr-mcp signs in as, and needs no permission
beyond access to the book. `get_history` reads Grimmory's audit log, which needs
an admin account. A write the account may not do fails with an error naming the
permission it lacks. Grimmory requires an email address for a new user, but
`arr-mcp@localhost` passes.

Grimmory counts failed logins per client IP and allows five in 15 minutes. Behind
a reverse proxy that IP can be the proxy's, so a wrong password here could lock
your own browser out too. After a rejected login (401, 403 or 429, or a 200 with
no token), arr-mcp stops trying for 15 minutes and reports the credentials as
wrong, so it can never be the one that locks the account out. Fixing the password
in the config clears it. Other failures, such as a 5xx, fail that request without
the wait. arr-mcp does not refresh tokens, since a failed refresh counts against
the same limit; it logs in again once an access token expires, about every two
hours of use.

Single instance only, because `get_library` needs one book source. Needs
Grimmory 3.5.0 or newer, the version the adapter was written against.

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
  bazarr:                    # one per stack: Bazarr takes a single *arr of each
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

**Reads span every instance.** `get_stack_health` reports each separately, and a
library question answers from all of them at once. Every row says which
instance it came from, as `radarr/4k`.

**Writes name one.** With two Radarrs configured, a write with no `instance` is
refused and the refusal lists the names. So **adding a second instance changes
how existing prompts behave**: writes that used to be unambiguous start asking
which instance you meant. See [writes](writes.md#with-more-than-one-instance-writes-name-one).

**Permissions are per instance**: each entry carries its own `permissions`
block.

**Ten services stay single.** Jellyfin and Plex because each is one server
([running both](#plex-and-jellyfin-together) is a different thing). Seerr
because a request carries the identity of the person who made it. Whisparr
because the one deployment that wants two is V2 beside V3 (Eros), and Eros is a
different API with no adapter. Profilarr because it owns profile config.
Cleanuparr, Reclaimerr, Dispatcharr, Shelfmark and Grimmory for the reasons in
their own sections.

Everything else takes a list: Radarr, Sonarr, Lidarr, Bazarr, Prowlarr, SABnzbd,
NZBGet, Transmission and qBittorrent.

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
`qbittorrent/vpn`. `pause_downloads` needs `instance` to say which one to stop;
with two configured, omitting it is refused.

**Two Prowlarrs with overlapping indexers return the same release twice.**
`search_media` fans out across every configured Prowlarr and labels each row
with the instance it came from, so a release both of them index comes back once
per instance. That is intended: the two copies may differ in priority or in
what they will actually grab.

## Access

```yaml
auth:
  username: admin
  password_hash: "…"         # scrypt; written by the setup page, never by you
  allowed_hosts: []          # empty accepts any Host, right for a LAN container
  trusted_proxies: []        # reverse proxies whose forwarded headers are believed
  tokens:                    # named MCP tokens; see MCP tokens below
    - name: claude-desktop
      tier: destructive
      hash: sha256:9f2c…
  allow_token_in_url: false  # accept ?token=… when no Authorization header is sent
```

A misspelled or leftover key anywhere in this block, including inside
`auth.oauth` below, **fails at startup with the offending field named**, so a
config that loaded on an earlier release can stop loading after an upgrade. The
server then drops into repair mode (see [When config.yaml will not
load](#when-configyaml-will-not-load)), where the editor is reachable once you
sign in.

Sign-in is a username and password you choose the first time you open the UI.
Only a scrypt hash is stored, so the password cannot be recovered, but it can
be replaced: delete the `password_hash` line and restart, and the setup page
comes back. An instance with no `password_hash` is *unclaimed*, and every page
redirects to setup until someone claims it.

`allowed_hosts` applies at once when saved from the UI, so **a wrong hostname
locks you out of the page you would fix it from.** Recover by editing
`config.yaml` by hand and restarting. A literal IPv6 address is written with its
brackets, `"[fd00::1]"`, and matches with or without a port.

### `trusted_proxies`

The addresses of reverse proxies in front of arr-mcp, as single addresses or
CIDR ranges:

```yaml
auth:
  trusted_proxies:
    - 172.18.0.0/16   # the Docker network the proxy runs on
    - 192.168.1.5
```

It decides two things.

Which address a failed config UI sign-in counts against. Without the list,
every request counts against the address that connected, so behind a proxy all
your clients share the proxy's counter, and five wrong passwords from anywhere
delay the next sign-in for everyone. With the proxy listed, each client gets its
own counter, taken from the last `X-Forwarded-For` hop the proxy added, or from
the last `for=` of the standard `Forwarded` header when the proxy sends only
that. Both headers are ignored from an address not on the list, so a client
cannot pick its own counter by sending them. When both arrive, `X-Forwarded-For`
wins: nginx and Traefik append to it but pass `Forwarded` through as the client
wrote it.

Whose word on https is taken. arr-mcp marks the session cookie Secure, and
builds the OAuth metadata URL it hands MCP clients, from the scheme the browser
used. Behind a TLS-terminating proxy that scheme arrives as `X-Forwarded-Proto`
(or the `proto=` of `Forwarded`). While the list is empty, `X-Forwarded-Proto`
is believed from any peer, as before the setting existed, so an existing proxy
setup keeps working. Once the list is set, both are believed only from the
listed proxies, and a request from anywhere else is read as plain http.

Absent or empty is the default. Set it on the config page, under MCP endpoint,
or here. An entry that is not an address or a range fails at startup. Repair
mode ignores it: it counts per connecting address and takes
`X-Forwarded-Proto` from any peer.

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

### `auth.management_keys`

The keys for the [management API](api.md). Without any, `/api/v1` answers 404.

```yaml
auth:
  management_keys:
    - name: nzb360
      tier: read
      hash: sha256:9f2c…
      created: 2026-09-29
```

Each entry has a unique `name`, compared regardless of case. `tier` is `read`,
which can only look, or `admin`, which can also change services, settings and MCP
tokens. Only the hash is stored, and there is no plaintext form to write by hand.
Create keys on the config page, where each is shown once. Deleting the block
turns the API off.

**Upgrading from `management_key`.** Your existing key becomes a key named
`default` with the `admin` tier, so apps keep working. The file keeps the old
block until the next save from the config page or the API, which rewrites it as
`management_keys`. If `default` is only used by a dashboard, create a `read` key,
move the app to it and revoke `default`.

**Downgrading.** Older versions do not know `management_keys` and open the repair
page instead of starting. Remove the block, start the old version and generate a
new key.

### `allow_token_in_url`

For MCP clients that can only be given a URL. With this on,
`/mcp?token=<MCP token>` authenticates the same as the header does. An
`Authorization: Bearer` header still wins whenever one is sent, right or wrong.

The cost is that the token travels in the address, so a reverse proxy's access
log, a browser history or a shell history will hold a working credential. Nothing
in arr-mcp logs a URL, but everything in front of it might. If one leaks, revoke that
token and create a new one.

**This does not make Home Assistant work on its own.** Its MCP client speaks
only the older HTTP+SSE transport, so it still needs a proxy to bridge to
Streamable HTTP.

### `auth.oauth`

Lets an MCP client authenticate with a short-lived OAuth 2.1 access token
instead of an MCP token.

**arr-mcp is only the resource server here.** It does not issue tokens, does
not run an authorization server, and does not discover one: you need an
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
    audience: arr-mcp                                 # required; see below
    jwks_uri: https://issuer.example.com/jwks.json    # required; see below
    scopes:                                           # renameable; defaults shown
      read: arr-mcp:read
      write: arr-mcp:write
      destructive: arr-mcp:destructive
```

Absent means off, exactly like a service nobody configured.

To turn it on: give your authorization server an audience (or resource
identifier) for arr-mcp, any string that matches `audience` exactly, and point
`jwks_uri` at wherever that server publishes its signing keys. There is no OIDC
discovery, so `jwks_uri` has to be given directly.

`audience` is required too. Without it, every token that issuer ever minted
for any of its clients would be accepted here.

Each scope your authorization server can grant maps to one access level:

| Scope | Grants |
| --- | --- |
| `arr-mcp:read` | Read tools |
| `arr-mcp:write` | The `safe` tier, where `config.yaml` permits it |
| `arr-mcp:destructive` | The `destructive` tier, where `config.yaml` permits it |

`scopes:` renames the three strings your provider must grant; it never changes
the mapping to the tiers.

The scopes are unioned: `arr-mcp:destructive` carries the `safe` tier with it,
the same as `destructive: true` grants `safe_write`. Any of the three grants
the read tools. A token carrying none of them is refused with
`403 insufficient_scope`, never silently downgraded to read.

`config.yaml` stays the sole authority: a scope only narrows what the file
already permits. A token carrying `arr-mcp:destructive` against an instance
with `destructive: false` is still refused.

`allow_token_in_url` cannot be set while `oauth` is configured: it is refused at
config load and disabled in the config UI.

With this block configured, a credential-less client's first request runs the
OAuth discovery-and-authorize flow and ends in a 401 without the message
telling it to configure a token.

**Checking it worked.** Once the container is back up,
`curl http://<host>:6060/.well-known/oauth-protected-resource` should return a
JSON document naming your `issuer` under `authorization_servers`. A client
that implements RFC 9728 discovery finds this on its own; one that does not
can be handed a token directly as `Authorization: Bearer <token>`.

If a client's token is refused, the status code says why:

| Status | Cause | Fix |
| --- | --- | --- |
| `401` | Bad signature, wrong `issuer` or `audience`, missing or expired `exp` | Check the token was minted for this `audience`, by this `issuer`, and has not expired |
| `403 insufficient_scope` | The token carries none of the three scopes | Grant it at least one of `arr-mcp:read`, `arr-mcp:write` or `arr-mcp:destructive` (or your renamed equivalents) |
| `503` | arr-mcp could not fetch `jwks_uri` | Check the issuer is reachable from the container, not from your browser |

A `503` means arr-mcp could not check the token. Retrying once the issuer is
reachable again works with no other change. The exception is a token whose own `exp` has already passed: that
still gets a `401` during an outage, because no retry would help it.

### `allow_other_users`

On Jellyfin and Seerr, one admin-scoped API key can answer for anybody, so
`allow_other_users` decides whether this server will deal in anyone's data but
`default_user`'s. It governs reading (whose watch state, whose requests) and
also whether `respond_to_request` and `delete_request` may act on a request
somebody else made. It defaults to `false`.

Plex has no equivalent: a Plex token is scoped to one account, so there is no
second user to permit. `services.plex.allow_other_users: true` is refused at
config load rather than accepted and ignored.

### Over stdio

`node dist/src/index.js --stdio` serves MCP on stdin and stdout instead of
over HTTP, for a client that starts arr-mcp as a child process. It offers the
same tools, prompts and resources as `/mcp`, and reads the same
`ARR_MCP_CONFIG_DIR`. In the container:

```bash
docker run -i --rm -v ./config:/config ghcr.io/bardesss/arr-mcp:latest node dist/src/index.js --stdio
```

A stdio connection is **read-only**, whatever `config.yaml` permits, because it
presents no token. A write is refused with a pointer to `/mcp`, and the audit trail
records the caller as `stdio`. For writes, use the HTTP endpoint with a token of
the write or destructive tier.

There is no config UI and no HTTP listener in this mode. Set the services up
first, in the UI of an HTTP instance or in `config.yaml` by hand, and point
`--stdio` at the same directory. A missing `config.yaml` is created as on any
first start, which gives a server with no services that still lists every tool.
A `config.yaml` that will not load is fatal here, with the reason on stderr,
because there is no repair page to fall back on. Log lines go to stderr, since
stdout is the MCP connection.

### Editing `config.yaml` by hand

Supported, and your comments are preserved when the config UI saves over it. If
you edit the file while the config page is open, the next save from that page
is **refused**, because it was built from the file before your edit. Reload the
page and make the change again.

## Environment variables

| Variable | Default | What it sets |
| --- | --- | --- |
| `ARR_MCP_CONFIG_DIR` | `/config` | The folder holding `config.yaml`, and the logs, audit trail, sessions and event log kept beside it |
| `ARR_MCP_PORT` | `6060` | The HTTP port for `/mcp`, the config UI and webhooks. arr-mcp listens on it on every interface, IPv6 and IPv4, or IPv4 only where IPv6 is switched off |
| `LOG_LEVEL` | `info` | Log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` |

In the container, publish a different host port (`-p 8080:6060`) rather than
changing `ARR_MCP_PORT`.

## When config.yaml will not load

A config that fails validation starts arr-mcp in repair mode. The page at `http://<host>:6060` shows the
validation error and the file in a text box. Fix it, save, and the server starts
normally without a restart. There is no MCP endpoint and no services until then;
`/mcp` answers `503` and `/healthz` reports `degraded` with a `200` status, so a
container healthcheck built on `/healthz` does not restart-loop it.

Sign-in works as usual. If nobody has claimed the instance yet, you claim it
first, exactly as on a fresh install, unless the file already holds a
credential: a service, an MCP token, a management key or the event log's
secret. Claiming opens the editor, which shows the file with every key in it,
so the page refuses and asks you to fix `config.yaml` directly and restart. The
setup page then works as on a fresh install. A config you wrote by hand before
the first start, with one typo in it, is the usual way to get here.

**The one case this cannot fix** is a file whose sign-in fields cannot be read:
YAML that does not parse, a top level or an `auth:` that is not a mapping, or a
`username`, `password_hash`, `allowed_hosts` or `allow_token_in_url` of the
wrong type (an empty `username` or `password_hash` counts). There is then no
password to check, and offering the setup page instead would let anyone who can
reach the port take the instance over. The page shows
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
fallback for everything else; see [IMDb ratings](imdb.md) for what it costs and
whether you need it.

## The library event log

```yaml
webhooks:
  enabled: true
  secret: <at least 32 characters>
  retention_days: 30   # default
```

Off by default. Radarr, Sonarr and Lidarr lose a title's history when it's deleted, so
this keeps what they report in `events.db`, next to `audit.db`, where a delete
can't reach it. Without it nothing listens: `/webhooks/*` answers 404.

You can read the events under **Library events** on the Logs page, with
[`get_history`](tools.md#get_history-and-the-event-log) and `source: "webhooks"`,
and through `diagnose_media` when a title is no longer in your library.

Turn it on under **Library event log** on the Settings page, which writes a
generated secret and takes effect at once. Then add a connection in each Radarr,
Sonarr and Lidarr instance, under Settings, Connect, Webhook:

| Field | Value |
|-------|-------|
| URL | `http://<arr-mcp as the service reaches it>:6060/webhooks/radarr`, `/webhooks/sonarr`, `/webhooks/lidarr`, or `/webhooks/radarr/4k` for a named instance |
| Method | POST |
| Username | `arr-mcp` (any name works) |
| Password | The password shown on the Settings page |

Tick these triggers:

| Trigger | Stored as |
|---------|-----------|
| On Grab | `grabbed` |
| On File Import, On File Upgrade (Lidarr: On Release Import, On Upgrade) | `imported` |
| On Movie Added, On Series Add, or On Artist Add | `added` |
| On Movie Delete, On Series Delete, On Artist Delete or On Album Delete | `deleted`, and whether the files went too |
| On Movie File Delete, or On Episode File Delete | `deleted`, with the reason |
| On Download Failure (Lidarr only) | `failed` |

The file delete for an upgrade, On Rename and On Manual Interaction Required are
optional. The first adds a row to every upgrade, and the other two are kept as
`unknown`. Leave the health triggers and On Application Update off: they aren't
about a title, and their message isn't kept. In Sonarr, also leave On Import
Complete off: On File Import already reports each import, and with both on you
may get a second row.

Press Test in the service: a 200 means it's connected, and the test isn't stored.

If you've set [`allowed_hosts`](#access), the host name in that URL has to be in
the list. A container name like `arr-mcp` usually isn't, and the service gets a
403 until it is.

Only Radarr, Sonarr and Lidarr are accepted. Rename, manual interaction and health
events are kept as `unknown` under their own name.

Turning the log off keeps the secret and the stored events, and stops accepting
new ones. Events past `retention_days` go when the next event arrives, with a
limit of 50,000 rows underneath. See
[Security](security.md#the-library-event-log) for what's stored.

## Appearance

```yaml
ui:
  theme: dark   # system (default) · dark · light
```

`system` follows the browser's `prefers-color-scheme` and tracks your OS as it
changes; the other two override it. Omit the block for `system`; choosing it on
the Settings page removes the block. It is stored server-side, so it holds
wherever you sign in from.

## The tools a client sees

arr-mcp sends a client only the tool text that applies to your stack:

- a tool's `service` field lists only the services it takes that you have
  configured;
- a sentence about a service you do not run is left out of a description;
- longer field-by-field references are resources, `arr://docs/<tool>`, read
  only when a client asks for one;
- a write tool is left out when none of its services is configured:
  `trigger_subtitle_search` without Bazarr, `request_media` without Seerr,
  `sync_database` without Profilarr, and so on. With nothing configured yet,
  every tool is listed.

The reads are still all listed, so a saved prompt keeps finding the tool it
names. On a small stack you can hide those too:

```yaml
tools:
  hide_unusable: true   # default false
```

With it on, a read that does nothing without a service you have not configured
is left out as well: `get_subtitles` without Bazarr, `get_requests` without
Seerr, and so on. The reads that merge across services (`get_library`,
`get_queue`, `get_history`, `diagnose_media`, the lookups) always stay. It is set in
`config.yaml` only, and takes effect after a restart (or the next save from the
configuration page, which reloads the config).

### Poster cards

In a client that renders [MCP Apps](https://github.com/modelcontextprotocol/ext-apps),
`get_media_details`, `search_media` and `get_library` show films
and series as poster cards. Building them reads the Radarr and Sonarr queues for
the "downloading" badge, so it only happens for a client that declares MCP Apps
support. Over stateless HTTP the cards are always built unless you turn them
off:

```yaml
tools:
  media_cards: false   # default true
```

That also removes the `_meta.ui` key from those four tools and the
`ui://arr-mcp/media-cards.html` resource.
