# Management API

A JSON API for companion apps such as nzb360 or ArrMatey, so they can look at
arr-mcp the way they look at Sonarr. It shows what the config page shows, and
it can change the same things: services, their permissions, IMDb, the MCP
endpoint's token setting and MCP tokens.

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

The key can write config, so treat it like an admin credential. It can never
touch sign-in, OAuth, `allowed_hosts`, the key itself or appearance. Nothing in
this API can change them.

## Conventions

- Base URL: `http://<host>:6060/api/v1`.
- Field names are camelCase.
- The API's own errors are `{"message": "..."}` with one of these statuses:

| Status | Meaning |
| --- | --- |
| 400 | A bad parameter or body. The message names it. Malformed JSON gets `The request body is not valid JSON.` |
| 401 | `Missing or wrong X-Api-Key.` |
| 403 | `forbidden: Host not allowed`, as plain text. This comes from `auth.allowed_hosts`, before the API sees the request |
| 404 | No key configured (`The management API is off. Generate a key on the config page to turn it on.`), `No such endpoint.`, `No such app.`, or `No such token.` |
| 412 | The config changed since you read it. See [Concurrency](#concurrency) |
| 415 | A write body that is not `application/json` |
| 500 | A write that could not be saved for another reason, such as config.yaml not being writable. The server log has the details |
| 503 | `config.yaml is invalid; fix it on the web UI.` The server is in repair mode |

- `/app`, `/app/...`, `/settings/*` and `/token` carry a strong `ETag`
  (`"<16 hex>"`). It is one tag for the whole config, so it changes when any
  part of it does.
- The API's own answers have `cache-control: no-store`. The 403 above does
  not, and neither does the `413` for a body over 4 MB, which comes back in
  JSON-RPC shape from the same guard that protects `/mcp`. A malformed JSON
  body is different: on `/api` it gets the `{message}` 400 above.
- Secrets never come back. A service's API key or password appears only as
  `apiKeySet` or `passwordSet`, and the key hashes are not returned at all.

### Concurrency

Every config read returns an `ETag`. Send it back as `If-Match` on a write. If
the config moved since, the write gets a 412 and changes nothing. Without
`If-Match` the write is still checked: if config.yaml was edited on disk after
the request began, that is a 412 too, so nothing is silently overwritten. On a
412, GET again and retry.

```bash
curl -i -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/settings/imdb
# ETag: "9f2c41d07a6b3e58"

curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -H 'If-Match: "9f2c41d07a6b3e58"' -d '{"enabled": true}' \
  http://arr-mcp:6060/api/v1/settings/imdb
```

If the ETag is stale:

```json
{ "message": "The config changed since you read it. Read it again and retry." }
```

### Updating an app

GET the app, change what you want, PUT the whole object back.

- An omitted field is unchanged.
- `null` clears `username` and `defaultUser`.
- `apiKey` and `password` can be replaced, but never read or cleared. `null` is
  a 400, and an empty string means unchanged.
- A `url` equal to the one GET showed keeps the stored URL, and any credentials
  in it. A different `url` replaces the stored one, credentials included.
- Send `safeWrite` or `destructive` on its own and the other keeps its value.
- Read-only fields from GET (`id`, `apiKeySet`, `passwordSet`, `type`, `name`)
  are accepted and ignored. Any other unknown field is a 400.
- A field that does not apply to the app's type, such as `password` on Radarr,
  is accepted and ignored for now.

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
`error` with `kind` and `detail` when it is not, and `remedy` when there is
one.

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
      "kind": "AuthFailed",
      "detail": "HTTP 401 at /api/v3/system/status",
      "remedy": "The API key is wrong. Check the service’s Settings → General page."
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
      "app": null,
      "message": "rejected a management API request with a missing or wrong key",
      "fields": { "ip": "192.168.1.20", "path": "/api/v1/system/status" }
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
    "url": "http://radarr:7878",
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
`passwordSet`. Everything else has `apiKeySet`. Jellyfin, Plex and Seerr add
`defaultUser` and `allowOtherUsers`, and Plex alone adds `allowMetadataRepair`. Any
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
  "url": "http://radarr:7878",
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
eight hex characters after `sha256:` in the stored hash, so you can tell them
apart.

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

### `POST /app`

Adds an app. `type` and `url` are required, and so is `apiKey` for every type
except Transmission and qBittorrent. The other fields are the ones in the
[update list](#updating-an-app): `username`, `password`,
`defaultUser`, `allowOtherUsers`, `timeoutMs`, `safeWrite`, `destructive` and
`allowMetadataRepair`.

A second instance of a type that allows several needs a `name`. If the first
one has no name yet, also send `renameExistingTo` to name it, because its id
changes. Answers 201 with the new app.

```bash
curl -X POST -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"type": "radarr", "name": "uhd", "renameExistingTo": "hd", "url": "http://radarr-uhd:7878", "apiKey": "abc123"}' \
  http://arr-mcp:6060/api/v1/app
```

```json
{
  "id": "radarr/uhd",
  "type": "radarr",
  "name": "uhd",
  "url": "http://radarr-uhd:7878",
  "timeoutMs": 10000,
  "safeWrite": false,
  "destructive": false,
  "apiKeySet": true
}
```

### `PUT /app/{type}` and `PUT /app/{type}/{name}`

Saves changes to one app, as described under
[Updating an app](#updating-an-app). Answers 200 with the saved app. An unknown
app is a 404.

```bash
curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"timeoutMs": 20000, "safeWrite": true}' \
  http://arr-mcp:6060/api/v1/app/radarr/hd
```

### `DELETE /app/{type}` and `DELETE /app/{type}/{name}`

Removes one app. Answers 200 with `{}`. An unknown app is a 404.

```bash
curl -X DELETE -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/app/radarr/uhd
```

### `POST /app/test`

Tests a connection without saving anything. Send `id` (such as `radarr/hd`) to
test an existing app with the body's changes applied, or `type` plus fields to
test a new one. It answers 200 with the diagnosis if the app connects, and 400
with the same body shape if not. An unknown `id` is a 404 with `No such app.`,
and a body with neither `id` nor `type` is a 400 with
`Send the id of an app, or a type.`

```bash
curl -X POST -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"id": "radarr/hd", "url": "http://radarr:7878", "apiKey": "abc123"}' \
  http://arr-mcp:6060/api/v1/app/test
```

```json
{
  "ok": true,
  "app": "radarr/hd",
  "latencyMs": 42,
  "version": "5.1.0"
}
```

When it fails, `ok` is `false` and `error` has `kind`, `detail` and sometimes
`remedy`, like [`GET /health`](#get-health).

### `PUT /settings/imdb`

Turns the IMDb dataset on or off. Send `enabled`. The other fields from GET are
accepted and ignored. Answers 200 with the same body as GET.

```bash
curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"enabled": true}' http://arr-mcp:6060/api/v1/settings/imdb
```

### `PUT /settings/mcp`

Changes `allowTokenInUrl`. `oauthConfigured` from GET is accepted and ignored.

`allowedHosts` is read-only here. It is accepted only if it equals the current
list, so a body you got from GET can be sent back. Anything else is a 400 with
`allowedHosts can only be changed on the config page.` The pin also gates the
config page, so a leaked key could otherwise lock the owner out.

```bash
curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"allowTokenInUrl": true}' http://arr-mcp:6060/api/v1/settings/mcp
```

### `POST /token`

Creates an MCP token. `name` starts with a letter or digit, then may use
letters, digits, dashes or underscores. Names are unique regardless of case,
so `Phone` clashes with `phone`. `tier` is `read`, `write` or `destructive`. `expiry` is `"30"`, `"90"` or `"never"`.
Answers 201.

The plaintext `token` is in this response only. It cannot be read again.

```bash
curl -X POST -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name": "companion", "tier": "read", "expiry": "30"}' \
  http://arr-mcp:6060/api/v1/token
```

```json
{
  "name": "companion",
  "tier": "read",
  "expires": "2026-10-29",
  "fingerprint": "e5f6a7b8",
  "expired": false,
  "plaintextOnDisk": false,
  "token": "amcp_<64 hex characters>"
}
```

### `DELETE /token/{name}`

Revokes a token. It stops working at once. Answers 200 with `{}`. An unknown
name is a 404.

```bash
curl -X DELETE -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/token/companion
```
