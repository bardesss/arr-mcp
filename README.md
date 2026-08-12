# arr-mcp

One MCP server for your whole self-hosted media stack — not one per service.

Radarr · Sonarr · Prowlarr · Bazarr · Jellyfin · Seerr · SABnzbd · Transmission

Ask questions no single service can answer. *"Why isn't the film I requested on
Tuesday showing up in Jellyfin?"* spans Seerr, Radarr, Prowlarr, SABnzbd and
Jellyfin. arr-mcp correlates them and gives you the causal chain.

```
diagnose { query: "Blade" }
```

> No file on disk yet. Trigger a search in Radarr or Sonarr — nothing is
> downloading and no indexer reported a failure.

- **`diagnose` answers what no single service can.** It walks the whole chain —
  requested, managed, monitored, downloaded, indexed, imported, scanned — and
  names the first thing that explains the absence, even with a service down.
- **Tool output is treated as untrusted data, never instruction.** Release names
  from public indexers are attacker-controllable and flow straight into model
  context; arr-mcp fences them.
- **Writes are opt-in, previewed, and recorded.** Every write is off until you
  turn it on per service, shows you exactly what it would do before it does it,
  and lands in an audit trail either way.
- **A config page that diagnoses.** Add services from a browser, see what is
  broken and what to do about it, and read the logs and the write audit.

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
```

**1. Open `http://<host>:6060`** — the bare host, no path. Nothing to read out
of the container log.

**2. Claim it.** The first page is a setup form rather than a sign-in: choose a
username and a password of at least 12 characters. Do this **before** exposing
the port — until it is claimed, whoever loads that page first owns it, and it
holds every service's API key.

**3. Add your services** — **Add a service**, paste its URL and API key, save.
It applies immediately; there is no restart. Configure only what you run.

Your MCP client goes to `http://<host>:6060/mcp` with the bearer token shown on
the dashboard. Everything the UI does is still just `config.yaml`, and editing
that by hand remains supported.

Image tags are `X.Y.Z`, `X.Y`, `X` and `latest`, plus `main` for bleeding edge.
Pin a minor — `:1.4` — if you would rather approve each new tool surface
yourself.

## Documentation

| | |
| --- | --- |
| **[Tools](docs/tools.md)** | All twenty-two, what each answers, and the fields whose meaning is not obvious |
| **[Writes](docs/writes.md)** | Turning them on, the two tiers, and the preview-and-confirm handshake |
| **[Configuration](docs/configuration.md)** | `config.yaml`, several Radarrs, Jellyfin's `default_user` |
| **[Config UI](docs/config-ui.md)** | The four pages, and what each does that is not obvious |
| **[IMDb ratings](docs/imdb.md)** | The only way to get an IMDb score for a series, and what it costs |
| **[Contributing](CONTRIBUTING.md)** | Adding a service adapter, and the rules an AI agent tends to break |

## Requirements

- At least one supported service, LAN-reachable: Radarr 4.0+, Sonarr 4.0+,
  Prowlarr 1.0+, Bazarr 1.4+, Jellyfin 10.8+, Seerr 1.0+, SABnzbd 3.0+,
  Transmission 3.0+
- Docker, or Node 24+ to run from source
- An MCP client speaking protocol revision `2026-07-28`

Since 1.0 the tool surface is the public API: renaming or removing a tool, a
parameter or a response field is a **major**, because that break is silent — a
model stops finding a renamed tool rather than raising an error.

## Contributing

**Contributions are welcome, and new service adapters most of all** — Lidarr,
Readarr, qBittorrent, Tautulli. An adapter is deliberately the most
self-contained thing in the codebase. One thing to know first: **I cannot test a
service I do not run**, so the bar is that you tested it against your own live
instance and the PR says what you tested and against which version.

**AI-assisted contributions are welcome**, held to the same bar and no other;
arr-mcp is itself built with a coding agent. Point yours at
[CONTRIBUTING.md](CONTRIBUTING.md#if-you-are-working-with-a-coding-agent).

**Missing a tool?** [Open an issue](../../issues/new/choose) describing the
question you could not get answered rather than the tool you think should
exist — at twenty-two tools the answer is usually a new parameter on one that
already exists.

## Security

arr-mcp is **not designed to be exposed to the internet.** The `/mcp` endpoint
requires a bearer token because "LAN-only" is a network assumption rather than a
security control — it fronts up to eight API keys and, once enabled, file
deletion, and a home network contains guest phones and IoT devices. Put it
behind a reverse proxy with TLS if it needs to leave the LAN, and pin
`allowed_hosts` if you do.

## Thanks

arr-mcp is glue; the hard parts belong to other people. Every service it speaks
to is free software maintained largely by volunteers — [Radarr](https://radarr.video),
[Sonarr](https://sonarr.tv), [Prowlarr](https://prowlarr.com),
[Bazarr](https://www.bazarr.media), [Jellyfin](https://jellyfin.org),
[Seerr](https://github.com/seerr-team/seerr), [SABnzbd](https://sabnzbd.org),
[Transmission](https://transmissionbt.com) — as are the libraries it is built
on: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[Hono](https://hono.dev), [Zod](https://zod.dev), [Pino](https://getpino.io),
[Vitest](https://vitest.dev), [yaml](https://eemeli.org/yaml/) and
[TypeScript](https://www.typescriptlang.org). If you find arr-mcp useful,
consider supporting them first.

When you enable the [IMDb dataset](docs/imdb.md): information courtesy of
[IMDb](https://www.imdb.com), used with permission, for personal and
non-commercial use.

## Licence

[MIT](LICENSE)
