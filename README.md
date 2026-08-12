# arr-mcp

One MCP server for your whole self-hosted media stack — not one per service.

Ask questions no single service can answer. *"Why isn't the film I requested on
Tuesday showing up in Jellyfin?"* spans Seerr, Radarr, Prowlarr, SABnzbd and
Jellyfin. arr-mcp correlates them and gives you the causal chain.

- **`diagnose` answers what no single service can.** It walks the whole chain —
  requested, managed, monitored, downloaded, indexed, imported, scanned — and
  names the first thing that explains why something isn't playable, even with a
  service down.
- **Tool output is treated as untrusted data, never instruction.** Release names
  from public indexers are attacker-controllable and flow straight into model
  context; arr-mcp fences them.
- **Writes are opt-in, previewed, and recorded.** Every write is off until you
  turn it on per service, shows you exactly what it would do before it does it,
  and lands in an audit trail either way.
- **A config page that diagnoses.** Add services from a browser, see what is
  broken and what to do about it, and read the logs and the write audit — no
  hand-edited YAML, no restart.

## Services

Radarr · Sonarr · Prowlarr · Bazarr · Jellyfin · Seerr · SABnzbd · Transmission

Configure only what you run. Anything you leave out is simply absent, not
broken.

## Tools

| Tool | Answers |
| --- | --- |
| `diagnose` | Why is this not playable? |
| `stack_health` | Is anything broken, out of disk, or not scanning? |
| `search_media` | What do I have, what exists, what can I get? |
| `get_media_details` | Everything about one item |
| `get_library` | What's in my library — joined across Radarr, Sonarr and Jellyfin, and where the three disagree |
| `get_queue` | What is downloading, across all four download paths |
| `get_calendar` | What is due, and what just aired |
| `get_subtitles` | What is missing subtitles, and which providers are throttled |
| `get_playback` | What am I watching, and what can I continue |
| `get_indexers` | Which indexers are healthy, and what they recently rejected |
| `get_requests` | What has been requested, and what is still pending |
| `lookup_media` | Tell me about this, without adding it |
| `discover_media` | What exists in this genre, year, or rating band |
| `trigger_search` | Go look for this again |
| `set_monitoring` | Turn Sonarr monitoring on or off — a whole series, one season, or specific episodes |
| `remove_queue_item` | Get rid of this stuck or wrong download |
| `delete_media` | Remove this film or series, optionally from disk |
| `delete_episode_files` | Free disk from one Sonarr season or a handful of episodes, without touching the series |
| `respond_to_request` | Approve or decline what someone asked for |
| `delete_request` | Drop a request record entirely |
| `add_media` | Add this film or series and start looking for it |

The first thirteen are reads. The last eight write, and are off until you turn
them on — see [Writes](#writes).

Every tool but `diagnose` takes `detail` (`minimal`/`standard`/`full`) and
`limit`, and reports `{ total, returned, truncated }`, so a truncated answer
always says so. Tools spanning several services also report which ones they
could not reach — a long answer from one service can never silently hide
another.

**[Tools in detail →](docs/tools.md)** — field semantics, the filters that are
films only, and the values that are deliberately absent rather than `false`.

### Why is this not playable?

```
diagnose { query: "Blade" }
```

> No file on disk yet. Trigger a search in Radarr or Sonarr — nothing is
> downloading and no indexer reported a failure.

It walks the chain and names the first thing that explains the absence, with
what to do about it. Any step it could not check sets `certain: false` and the
summary names what was missed, because a confident verdict across a hole is
worse than no verdict.

## Quick start

Also in the repo as [`docker-compose.example.yml`](docker-compose.example.yml).

```yaml
services:
  arr-mcp:
    image: ghcr.io/bardesss/arr-mcp:latest
    container_name: arr-mcp
    ports:
      - 6060:6060
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Amsterdam
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:6060/healthz']
```

Tags are `X.Y.Z`, `X.Y`, `X` and `latest` for releases, plus `main` for bleeding
edge. Pin a minor — `:1.4` — if you would rather approve each new tool surface
yourself.

### First run

**1. Start it and open `http://<host>:6060`** — the bare host, no path. There is
nothing to read out of the container log.

**2. Claim it.** Nobody has set this instance up yet, so the first page is a
setup form rather than a sign-in: choose a username and a password of at least
12 characters.

> Do this **before** exposing the port. Until the instance is claimed, whoever
> loads that page first owns it — and it holds every service's API key.

**3. Add your services** on the Configuration page: **Add a service**, pick it,
paste its URL and API key, save. Saving applies immediately; there is no
restart.

Your MCP client goes to `http://<host>:6060/mcp`, with the bearer token shown on
the dashboard. No password is ever written to a log.

### Configuring by hand

Everything the UI does is still just `config.yaml`, and editing it by hand
remains supported — it needs a restart, because nothing is watching the file.

```yaml
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: "…"
  jellyfin:
    url: http://192.168.1.20:8096
    api_key: "…"
    default_user: "you"      # required if jellyfin is configured
  transmission:
    url: http://192.168.1.20:9091
    username: "…"            # Transmission has no API key
    password: "…"
```

A misspelled key, an unknown service, or an `api_key` on Transmission fails at
startup with the offending field named, rather than being silently ignored.

If `jellyfin` is configured, `default_user` is required: `get_library`,
`get_media_details` and `diagnose` all join Radarr/Sonarr against Jellyfin's
per-user watch state, and without a resolvable user they fail outright, naming
the field, rather than silently answering as if Jellyfin were not there. Leaving
`jellyfin` out entirely is fine — those tools then work from Radarr/Sonarr
alone.

### More than one Radarr, Sonarr or Bazarr

A separate 4K instance is a common setup, and arr-mcp reads both. Give each one
a name:

```yaml
services:
  radarr:
    - name: hd
      url: http://192.168.1.20:7878
      api_key: "…"
    - name: 4k
      url: http://192.168.1.20:7879
      api_key: "…"
  sonarr:                    # one instance needs no name and no list
    url: http://192.168.1.20:8989
    api_key: "…"
```

**Reads span every instance** and every row says which one it came from, as
`radarr/4k`. **Writes name one** — adding a film with two Radarrs configured and
no `instance` is refused, and the refusal lists the names rather than guessing.
Permissions are per instance.

Only Radarr, Sonarr and Bazarr take a list. The other five are one each:
Prowlarr feeds every *arr from one place, Seerr connects to your instances
itself, and a second download client is a different kind of setup from a quality
tier.

## Writes

Nothing writes to your stack until you say so, per service:

```yaml
services:
  radarr:
    permissions:
      safe_write: true       # monitor, trigger a search — reversible
      destructive: false     # delete files, remove requests — not
```

Both default to **false**. A service you add by hand-editing YAML acquires no
write access by doing so.

| Tier | Tools |
| --- | --- |
| `safe_write` | `trigger_search`, `set_monitoring`, `respond_to_request`, `add_media` |
| `destructive` | `delete_media`, `delete_episode_files`, `remove_queue_item`, `delete_request` |

Three things hold for every write:

- **It previews first.** Called without a confirmation token, a write tool
  resolves the target, reports exactly what it would do — in GB, for a delete —
  and hands back a single-use token bound to those exact arguments.
- **`dry_run: true` never writes.** It describes the effect, issues no token at
  all, and works even with the tier switched off.
- **Every attempt is recorded** in `config/audit.db` — applied, previewed,
  refused, dry run or failed. If that file cannot be written, writes are refused
  rather than proceeding unrecorded.

Write tools take `service` and `id`, never a title: fuzzy matching is fine when
a wrong match costs a wrong answer, and not fine when it costs an action against
the wrong film.

**[Writes in detail →](docs/writes.md)** — the tier boundary, token mechanics,
and why you unmonitor a season before deleting its files.

## IMDb ratings

**If you want IMDb scores for TV series, you need the IMDb dataset.** Nothing
else in this stack has that number — not Sonarr, not Seerr, not Jellyfin. Films
are unaffected: Radarr and Seerr both supply IMDb for those.

```yaml
metadata:
  imdb:
    enabled: true
```

Or tick **IMDb dataset** in the config UI. No account, no API key, nothing sent
anywhere: your container downloads two of IMDb's published files into a local
SQLite database. About **223 MB weekly, ~81 MB on disk**, and everything answers
exactly as it did before until the first ingest lands.

Off by default, and for anything other than a series' IMDb rating it is only a
fallback for Seerr.

**[The IMDb dataset in detail →](docs/imdb.md)** — where the gap comes from,
what it costs, and whether you need it.

## Prompts and resources

**Five prompts**, which most clients surface as slash commands:

| Prompt | Asks |
| --- | --- |
| `why_not_playable` | Why isn't this playable? |
| `whats_wrong` | What needs my attention right now? |
| `what_to_watch` | What should I watch tonight? |
| `best_in_library` | What's the best thing I own? |
| `whats_new` | What happened this week? |

**Three resources**, which a client can attach once rather than re-fetch:

| Resource | Holds |
| --- | --- |
| `arr://instances` | Every instance id and what it may do |
| `arr://health` | A stack verdict, stamped with when it was taken |
| `arr://library/summary` | Total, on disk, still wanted |

Client support for both is uneven, so **nothing is reachable only through
them**. On a client that surfaces neither, arr-mcp is exactly as capable — you
just have to know what to ask.

## Config UI

`http://<host>:6060`

| Page | What it is for |
| --- | --- |
| Dashboard | Every service tested live, plus disk space, failed health checks, scan staleness, and the bearer token for your MCP client |
| Configuration | Add, edit, test and remove service instances one at a time |
| Logs | Three streams — all activity, problems only, or one service |
| Write audit | Every write attempt — applied, previewed, refused or failed |

- **Connection tests diagnose rather than pass or fail** — a service that is
  down says what is wrong and what to do about it, not just that it failed.
- **Secrets never come back out.** API keys and passwords render as empty fields
  meaning *unchanged*, so a screenshot cannot carry them.
- **Each card saves on its own**, so editing your 4K Radarr cannot disturb the
  HD one, and saving applies immediately — no restart.
- **It works on a phone**, which is where you are when something stops playing.

**[The config UI in detail →](docs/config-ui.md)**

## Stability

**The tool surface is the public API** — and it breaks *silently*, because a
model stops finding a renamed tool rather than raising an error. So since 1.0:

| Change | Version |
| --- | --- |
| A tool renamed or removed, a parameter renamed or removed, a response field removed | **major** |
| A tool added, an optional parameter added, a response field added | minor |
| Everything else | patch |

## Contributing

**Contributions are welcome, and new service adapters most of all.** If you run
something this does not speak to — Lidarr, Readarr, qBittorrent, Tautulli — an
adapter is deliberately the most self-contained thing in the codebase, and
[CONTRIBUTING.md](CONTRIBUTING.md) walks through it.

One thing to know before you start: **I cannot test a service I do not run.** So
the bar for a new adapter is that *you* have tested it hard against your own
live instance, and that the pull request says what you tested and against which
version. Fixtures are captured from real services rather than hand-written for
the same reason — a test that passes against an invented shape proves nothing.

**AI-assisted contributions are welcome**, held to the same bar and no other.
arr-mcp is itself built with a coding agent. Point yours at
[CONTRIBUTING.md](CONTRIBUTING.md#if-you-are-working-with-a-coding-agent), which
has the four rules an agent tends to break — chief among them inventing a
fixture instead of capturing one, which produces a pull request that looks
finished and proves nothing.

**Missing a tool?** [Open an issue](../../issues/new/choose) and describe the
question you could not get answered rather than the tool you think should
exist — at twenty-one tools the answer is usually a new parameter on one that
already exists. Bugs use the bug form; it asks for versions and logs, without
which a report usually cannot be reproduced.

## Requirements

- A LAN-reachable install of at least one supported service, at or above its
  minimum version
- Docker, or Node 24+ to run from source
- An MCP client speaking protocol revision `2026-07-28`

| Service | Minimum |
| --- | --- |
| Radarr | 4.0.0 |
| Sonarr | 4.0.0 |
| Prowlarr | 1.0.0 |
| Bazarr | 1.4.0 |
| Jellyfin | 10.8.0 |
| Seerr | 1.0.0 |
| SABnzbd | 3.0.0 |
| Transmission | 3.0.0 |

A service below its floor is reported unhealthy and contributes nothing to
`stack_health` until it is upgraded.

## Security

arr-mcp is **not designed to be exposed to the internet.** The `/mcp` endpoint
requires a bearer token because "LAN-only" is a network assumption rather than a
security control — the endpoint fronts up to eight API keys and, once enabled,
file deletion, and a home network contains guest phones and IoT devices.

The UI is served over plain http, like the services it manages. Put it behind a
reverse proxy with TLS if it needs to leave the LAN, and pin `allowed_hosts` if
you do.

## Thanks

arr-mcp is glue. The hard parts belong to other people.

**The services it speaks to** — none of this exists without them, and every one
is free software maintained largely by volunteers:

[Radarr](https://radarr.video) · [Sonarr](https://sonarr.tv) ·
[Prowlarr](https://prowlarr.com) · [Bazarr](https://www.bazarr.media) ·
[Jellyfin](https://jellyfin.org) ·
[Seerr](https://github.com/seerr-team/seerr) · [SABnzbd](https://sabnzbd.org) ·
[Transmission](https://transmissionbt.com)

**The libraries it is built on:**
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) ·
[Hono](https://hono.dev) · [Zod](https://zod.dev) ·
[Pino](https://getpino.io) · [Vitest](https://vitest.dev) ·
[yaml](https://eemeli.org/yaml/) ·
[TypeScript](https://www.typescriptlang.org)

**The data it reads**, when you enable the IMDb dataset:

> Information courtesy of
> [IMDb](https://www.imdb.com) ([datasets](https://developer.imdb.com/non-commercial-datasets/)).
> Used with permission.

If you find arr-mcp useful, consider supporting the services above first.

## Licence

[MIT](LICENSE)
