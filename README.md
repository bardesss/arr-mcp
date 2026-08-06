# arr-mcp

One MCP server for your whole self-hosted media stack — not one per service.

Ask questions no single service can answer. *"Why isn't the film I requested on
Tuesday showing up in Jellyfin?"* spans Seerr, Radarr, Prowlarr, SABnzbd and
Jellyfin. arr-mcp correlates them and gives you the causal chain.

- **A web config page** that diagnoses connections instead of printing
  pass/fail, and shows live logs while you debug.
- **Tool output is treated as untrusted data, never instruction.** Release names
  from public indexers are attacker-controllable and flow straight into model
  context; arr-mcp fences them.
- **Safe by default.** Deletion is off until you deliberately enable it, and
  then still asks per call.

> ### Status: 0.4 — correlation across the stack
>
> `get_library` joins Radarr, Sonarr and Jellyfin into one record per title, on
> shared external ids — presence, ratings and watch state answered together
> instead of service by service. `diagnose` walks the whole chain from request
> to playable and names the first thing that explains a gap, even with
> services down. See [the roadmap](#roadmap).

## Services

Radarr · Sonarr · Prowlarr · Bazarr · Jellyfin · Seerr · SABnzbd · Transmission

All eight are supported as of 0.3.

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

Every tool but `diagnose` takes `detail` (`minimal`/`standard`/`full`) and
`limit`, and reports `{ total, returned, truncated }` — a truncated answer
always says so. Tools spanning several services also report which ones they
could not reach, and how many results each contributed, so a long answer from
one service can never silently hide another. `diagnose` takes a title, or an
exact `service` plus `id`, and returns a verdict rather than a list — see
below.

Reads only. Writes arrive in 0.5, behind per-service permission toggles and
per-call confirmation.

### Why is this not playable?

```
diagnose { query: "Blade" }
```

> No file on disk yet. Trigger a search in Radarr or Sonarr — nothing is
> downloading and no indexer reported a failure.

`diagnose` walks the whole chain — requested, managed, monitored, downloaded,
indexed, imported, scanned — and names the first thing that explains the
absence, with what to do about it. No single service can answer this on its
own: `get_library`'s `presence: arr_only` alone would only suggest Jellyfin
hasn't seen a file the *arr believes exists; `diagnose` checked further and
found Radarr itself has no file yet, and that neither the download queue nor
an indexer rejection explains why — which is the real answer, and the one
that actually tells you what to do next.

It also works with services down. Any step it could not check sets
`certain: false` and the summary names what was missed, because a confident
verdict across a hole is worse than no verdict.

## Quick start

```yaml
services:
  arr-mcp:
    image: ghcr.io/bardesss/arr-mcp:0.4
    ports: ['6060:6060']
    volumes: ['./config:/config']
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Amsterdam
    restart: unless-stopped
```

Tags are `X.Y.Z`, `X.Y`, `X` and `latest` for releases, plus `main` for
bleeding edge. Pin a minor while the tool surface is still moving.

On first start, `config/config.yaml` is created and **the bearer token for the
MCP endpoint is printed to the container log** — `docker logs arr-mcp`. Add
your services to that file:

```yaml
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: "…"
  jellyfin:
    url: http://192.168.1.20:8096
    api_key: "…"
    default_user: "you"      # whose watched state `watched` means
  transmission:
    url: http://192.168.1.20:9091
    username: "…"            # Transmission has no API key
    password: "…"
```

All eight are supported: `radarr`, `sonarr`, `prowlarr`, `bazarr`, `jellyfin`,
`seerr`, `sabnzbd`, `transmission`. Configure only what you run — anything you
leave out is simply absent, not broken.

A misspelled key, an unknown service, or an `api_key` on Transmission fails at
startup with the offending field named, rather than being silently ignored.

Until the config UI arrives in 0.6, edit the file by hand and **restart the
container** to pick up changes.

## Roadmap

| Version | Delivers |
| --- | --- |
| 0.1 / 0.2 | Walking skeleton: stateless MCP transport, bearer auth, Radarr, `stack_health` |
| 0.3 | The remaining seven service adapters and ten read tools |
| 0.4 | Cross-service correlation: identity resolver, three-way library join, `diagnose` |
| 0.5 | Writes: permission tiers, `dry_run`, write audit, per-call confirmation |
| 0.6 | Web config page: dashboard, diagnosing connection tests, log streams |
| 0.7 → 1.0 | Metadata providers, MCP resources and prompts |

Each version is a self-contained, shippable slice — the goal is that 0.4 already
answers questions no individual service can, with 0.5–0.7 making it complete.

0.1 and 0.2 are the same code under two tags. Dropping the component prefix
from the release configuration made the release tooling treat the package as
new and re-cut it; the changelog shows the same features twice. Not two
releases.

## Requirements

- A LAN-reachable install of at least one supported service, at or above its minimum version
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

A service below its floor is reported unhealthy — no disk space, no failing
health checks, no scan state, not just a version complaint — and
contributes nothing to `stack_health` until it is upgraded.

## Security

arr-mcp is **not designed to be exposed to the internet.** The `/mcp` endpoint
requires a bearer token because "LAN-only" is a network assumption rather than a
security control — the endpoint fronts up to eight API keys and, once enabled,
file deletion, and a home network contains guest phones and IoT devices.

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

| | |
| --- | --- |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | the protocol, and a stateless transport that made this simple |
| [Hono](https://hono.dev) | the HTTP server |
| [Zod](https://zod.dev) | config validation and tool input schemas |
| [Pino](https://getpino.io) | logging |
| [Vitest](https://vitest.dev) | tests |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | the log ring buffer and write audit |
| [yaml](https://eemeli.org/yaml/) | reading `config.yaml` |
| [TypeScript](https://www.typescriptlang.org) | the language |

If you find arr-mcp useful, consider supporting the services above first.

## Licence

[MIT](LICENSE)
