# Management API

A JSON API for companion apps such as nzb360 or ArrMatey, so they can look at
arr-mcp the way they look at Sonarr. It shows what the config page shows and
nothing more. This release is read-only: writes arrive in the next one.

## Turning it on

It is off until you turn it on. On the config page, under Access, the
**Management API** card has a **Generate key** button. The key is shown once,
with a copy button, and cannot be read back. Only its SHA-256 hash is stored.

**Regenerate key** stops the old key at once. **Turn off** (it asks once)
removes the key, and every `/api/v1` request answers 404 again.

## Authentication

Send the key in an `X-Api-Key` header. It is not accepted as `?apikey=`, because
a key in a URL ends up in proxy logs and browser history.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/app
```

The key and the MCP tokens are separate. The key does not work on `/mcp`, and an
MCP token does not work here. `allowed_hosts` applies to `/api/v1` like it does
everywhere else.

The key can never touch sign-in, OAuth, the key itself or appearance. Nothing in
this API can change them.

## Conventions

- Base URL: `http://<host>:6060/api/v1`.
- Field names are camelCase.
- Errors are `{"message": "..."}` with one of these statuses:

| Status | Meaning |
| --- | --- |
| 400 | A bad parameter. The message names it |
| 401 | `Missing or wrong X-Api-Key.` |
| 404 | No key configured (`The management API is off. Generate a key on the config page to turn it on.`), `No such endpoint.`, or `No such app.` |
| 503 | `config.yaml is invalid; fix it on the web UI.` The server is in repair mode |

- `/app`, `/app/...`, `/settings/*` and `/token` carry a strong `ETag`
  (`"<16 hex>"`). It is one tag for the whole config, so it changes when any
  part of it does.
- Every response has `cache-control: no-store`.
- Secrets never come back. A service's API key or password appears only as
  `apiKeySet` or `passwordSet`, and the key hashes are not returned at all.

## Endpoints

The examples use dummy names. `arr-mcp:6060` stands for wherever yours runs.

### `GET /system/status`

The app, its version, and the MCP endpoint, built from the address you reached
it on.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/system/status
```

```json
{
  "appName": "arr-mcp",
  "version": "1.38.1",
  "mcpUrl": "http://arr-mcp:6060/mcp"
}
```

### `GET /health`

A live connection test of every configured app, sorted by id. Same diagnosis the
dashboard and `stack_health` give: `version` when the app is up, and
`error` with `kind`, `detail` and `remedy` when it is not.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/health
```

```json
[
  {
    "app": "radarr/hd",
    "type": "radarr",
    "ok": true,
    "latencyMs": 42,
    "version": "5.1.0"
  },
  {
    "app": "radarr/uhd",
    "type": "radarr",
    "ok": false,
    "latencyMs": 3,
    "error": {
      "kind": "AuthError",
      "detail": "HTTP 401 from radarr:7878",
      "remedy": "Check the API key on the config page."
    }
  }
]
```

### `GET /log`

Recent log records, newest first.

| Parameter | Meaning |
| --- | --- |
| `level` | Minimum level: `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Default `trace` |
| `app` | Only records for this instance id, such as `radarr/hd`. An unknown id gives an empty list |
| `afterId` | Only records with an id above this. A whole number |
| `limit` | 1 to 300. Default 100 |

To poll for new lines, pass the highest `id` you have seen as `afterId`.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" "http://arr-mcp:6060/api/v1/log?level=warn&limit=2"
```

```json
{
  "records": [
    {
      "id": 118,
      "at": "2026-09-29T08:15:02.113Z",
      "level": "warn",
      "app": "radarr/uhd",
      "message": "source failed; degrading rather than failing",
      "fields": { "err": "HTTP 401", "path": "/api/v3/system/status" }
    },
    {
      "id": 97,
      "at": "2026-09-29T08:12:40.870Z",
      "level": "warn",
      "app": "radarr/hd",
      "message": "slow response",
      "fields": { "ms": "4200" }
    }
  ]
}
```

`app` is `null` for records that belong to no instance. `fields` values are
always strings.

### `GET /app`

Every configured instance, in alphabetical order.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/app
```

```json
[
  {
    "id": "radarr/hd",
    "type": "radarr",
    "name": "hd",
    "url": "http://radarr:7878/",
    "timeoutMs": 10000,
    "safeWrite": false,
    "destructive": false,
    "apiKeySet": true
  },
  {
    "id": "transmission",
    "type": "transmission",
    "name": null,
    "url": "http://transmission:9091",
    "timeoutMs": 10000,
    "safeWrite": false,
    "destructive": false,
    "username": "tx",
    "passwordSet": true
  }
]
```

Fields depend on the type. Transmission and qBittorrent have `username` and
`passwordSet`. Everything else has `apiKeySet`. Jellyfin and Seerr add
`defaultUser` and `allowOtherUsers`, and Plex adds `allowMetadataRepair`. Any
credentials in the URL are stripped.

### `GET /app/{type}` and `GET /app/{type}/{name}`

One instance. Use the name for a service with several instances, and leave it
off for one with a single instance. An unknown app is a 404.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/app/radarr/hd
```

```json
{
  "id": "radarr/hd",
  "type": "radarr",
  "name": "hd",
  "url": "http://radarr:7878/",
  "timeoutMs": 10000,
  "safeWrite": false,
  "destructive": false,
  "apiKeySet": true
}
```

### `GET /settings/imdb`

The IMDb dataset: whether it is on, and when it was last loaded and how much it
holds. The last three are `null` until a dataset is loaded.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/settings/imdb
```

```json
{
  "enabled": false,
  "ingestedAt": null,
  "titles": null,
  "ratings": null
}
```

### `GET /settings/mcp`

How the MCP endpoint is set up. `oauthConfigured` says whether an `auth.oauth`
block exists. Its contents are not returned.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/settings/mcp
```

```json
{
  "allowedHosts": [],
  "allowTokenInUrl": false,
  "oauthConfigured": false
}
```

### `GET /token`

The named MCP tokens. Never the tokens themselves: `fingerprint` is the first
eight characters of the hash, so you can tell them apart.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/token
```

```json
[
  {
    "name": "phone",
    "tier": "read",
    "expires": null,
    "fingerprint": "a1b2c3d4",
    "expired": false,
    "plaintextOnDisk": false
  }
]
```
