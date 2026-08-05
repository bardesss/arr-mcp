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

> ### Status: 0.2 — walking skeleton, published
>
> Radarr and a single `stack_health` tool. Runnable, but not yet useful for
> much — this is the foundation the rest lands on. **0.3 adds the remaining
> seven services and ten read tools.** See [the roadmap](#roadmap).

## Planned services

Radarr · Sonarr · Prowlarr · Bazarr · Jellyfin · Seerr · SABnzbd · Transmission

## Quick start

```yaml
services:
  arr-mcp:
    image: ghcr.io/bardesss/arr-mcp:0.2
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
```

Radarr is the only service 0.2 speaks to; the other seven land in 0.3. Until
the config UI arrives in 0.6, edit the file by hand and **restart the
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

- A LAN-reachable install of at least one supported service
- Docker, or Node 24+ to run from source
- An MCP client speaking protocol revision `2026-07-28`

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
