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

> ### Status: 0.1 walking skeleton
>
> Radarr and a single `stack_health` tool. Not yet useful — this is the
> foundation the rest lands on. See [the roadmap](#roadmap).

## Planned services

Radarr · Sonarr · Prowlarr · Bazarr · Jellyfin · Seerr · SABnzbd · Transmission

## Quick start

Not yet — there is no published image until 0.1.0 ships. Once it does:

```yaml
services:
  arr-mcp:
    image: ghcr.io/bardesss/arr-mcp:latest
    ports: ['6060:6060']
    volumes: ['./config:/config']
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Amsterdam
    restart: unless-stopped
```

The bearer token for the MCP endpoint is generated on first run and printed to
the container log. Until the config UI lands in 0.5, edit
`config/config.yaml` by hand and **restart the container** to pick up changes.

## Roadmap

| Version | Delivers |
| --- | --- |
| 0.1 | Walking skeleton: stateless MCP transport, bearer auth, Radarr, `stack_health` |
| 0.2 | The remaining seven service adapters and 11 read tools |
| 0.3 | Cross-service correlation: identity resolver, three-way library join, `diagnose` |
| 0.4 | Writes: permission tiers, `dry_run`, write audit, per-call confirmation |
| 0.5 | Web config page: dashboard, diagnosing connection tests, log streams |
| 0.6 → 1.0 | Metadata providers, MCP resources and prompts |

Design and implementation plans live in [`docs/superpowers/`](docs/superpowers/).

## Requirements

- A LAN-reachable install of at least one supported service
- Docker, or Node 24+ to run from source
- An MCP client speaking protocol revision `2026-07-28`

## Security

arr-mcp is **not designed to be exposed to the internet.** The `/mcp` endpoint
requires a bearer token because "LAN-only" is a network assumption rather than a
security control — the endpoint fronts up to eight API keys and, once enabled,
file deletion, and a home network contains guest phones and IoT devices.

## Prior art

Inspired by
[`BerryKuipers/mcp_services_radarr_sonarr`](https://github.com/BerryKuipers/mcp_services_radarr_sonarr),
which demonstrated the demand for this and is no longer maintained. arr-mcp is a
clean-room implementation and shares no code with it.

## Licence

[MIT](LICENSE)
