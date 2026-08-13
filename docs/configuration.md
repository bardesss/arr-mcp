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
    default_user: "you"      # required if jellyfin is configured — see below
  transmission:
    url: http://192.168.1.20:9091
    username: "…"            # Transmission has no API key
    password: "…"
```

All eight service ids: `radarr`, `sonarr`, `prowlarr`, `bazarr`, `jellyfin`,
`seerr`, `sabnzbd`, `transmission`. Configure only what you run — anything you
leave out is simply absent, not broken.

A misspelled key, an unknown service, or an `api_key` on Transmission **fails at
startup with the offending field named**, rather than being silently ignored.

Each service also takes an optional `permissions` block. Both flags default to
false, so the config above is read-only — see [writes](writes.md).

## Jellyfin needs a `default_user`

Not optional flavour. `get_library`, `get_media_details` (its title-query form)
and `diagnose` all join Radarr/Sonarr against Jellyfin's per-user watch state,
and without a resolvable user they fail outright, naming `default_user` and how
to set it, rather than silently answering as if Jellyfin were not there.

Leaving `jellyfin` out of `config.yaml` entirely is still fine — those tools
just work from Radarr and Sonarr alone.

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

## The IMDb dataset

```yaml
metadata:
  imdb:
    enabled: true
```

Off by default. It is the only source of an IMDb rating for a TV series, and a
fallback for everything else — see [IMDb ratings](imdb.md) for what it costs and
whether you need it.
