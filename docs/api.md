# Management API

A JSON API for companion apps such as nzb360 or ArrMatey, so they can look at
arr-mcp the way they look at Sonarr. It shows what the config page shows, and
it can change the same things: services, their permissions, the primary media
server, IMDb, the MCP endpoint's token setting and MCP tokens.

## Turning it on

It is off until you turn it on. On the config page, under Access, the
**Management API** card creates keys: pick a name and a tier. A key is shown
once, with a copy button, and cannot be read back. Only its SHA-256 hash is
stored.

Give each app its own key, so you can revoke one without touching the others.
**Revoke** (it asks once) stops a key at once. Revoking the last key turns the
API off, and every `/api/v1` request answers 404 again.

## Authentication

Send a key in an `X-Api-Key` header. It is not accepted as `?apikey=`, because
a key in a URL ends up in proxy logs and browser history.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/app
```

Keys and MCP tokens are separate. A key does not work on `/mcp`, and an MCP token
does not work here. `allowed_hosts` applies to `/api/v1` like it does everywhere
else.

## Tiers

| Tier | What it can do |
| --- | --- |
| `read` | `GET` and `HEAD` only. Any other method gets a 403, before the body is read. It is enough for a dashboard |
| `admin` | Everything in this document |

A read key sees everything the endpoints below return, including service URLs,
MCP token names and the log. It still never sees a secret.

An admin key can write config, so treat it like an admin credential. It can
create MCP tokens, and it can send a service's stored credential to a new host
(see [security](security.md)).

Nothing in this API can change sign-in, OAuth, `allowed_hosts`, appearance or
the management keys.

The server log names the key behind each saved change, connection test and
refused request as `name#fingerprint`.

## Conventions

- Base URL: `http://<host>:6060/api/v1`.
- Field names are camelCase.
- The API's own errors are `{"message": "..."}` with one of these statuses:

| Status | Meaning |
| --- | --- |
| 400 | A bad parameter or body. The message names it. Malformed JSON gets `The request body is not valid JSON.` |
| 401 | `Missing or wrong X-Api-Key.` |
| 403 | A write with a read key, as `{"message": "Key 'nzb360' is read-only. ..."}`. Or `forbidden: Host not allowed`, as plain text, which comes from `auth.allowed_hosts` before the API sees the request |
| 404 | No key configured (`The management API is off. Create a key on the config page to turn it on.`), `No such endpoint.`, `No such app.`, or `No such token.` |
| 409 | `config.yaml was changed by hand and no longer loads. Fix the file, then retry.` Nothing was written |
| 412 | The config changed since you read it. See [Concurrency](#concurrency) |
| 415 | A write body that is not `application/json` |
| 500 | A write that could not be saved for another reason, such as config.yaml not being writable. The server log has the details |
| 503 | `config.yaml is invalid; fix it on the web UI.` The server is in repair mode |

- `/app`, `/app/...`, `/settings/*` and `/token` carry a strong `ETag`
  (`"<16 hex>"`). It is one tag for the whole config, so it changes when any
  part of it does.
- The API's own answers have `cache-control: no-store`. The plain-text 403
  above does not, and neither does the `413` for a body over 4 MB, which comes
  back in JSON-RPC shape from the guard that protects `/mcp`, before any key is
  checked.
- Secrets never come back. A service's API key or password appears only as
  `apiKeySet` or `passwordSet`, and the key hashes are not returned at all.
  A credential read from a file or an environment variable (see
  [configuration](configuration.md#secrets-from-files-or-the-environment))
  also has `apiKeyFrom` or `passwordFrom`, set to `file` or `environment`.
- An instance id such as `radarr/hd` is `id` on `/app` but `app` on `/health`,
  `/log` and in the `/app/test` answer, because on `/log` the value isn't
  always an instance id (it can be a source such as `jellyfin:seasons`).

### Concurrency

Every config read returns an `ETag`. Send it back as `If-Match` on a write. If
the config moved since, the write gets a 412 and changes nothing. Without
`If-Match` the write is still checked: if config.yaml changed on disk since the
server last loaded it, that is a 412 too. The server reloads the file when that
happens, so a GET and a retry work. If the hand edit left the file invalid,
writes get the 409 above until the file is fixed. The ETag also changes on a
restart, which gives a normal 412.

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
- `null` clears `username` and `defaultUser`, and so does an empty string.
- `apiKey` and `password` can be replaced, but never read or cleared. `null` is
  a 400, and an empty string means unchanged. A `url` on another scheme, host
  or port is a 400 unless a new `apiKey` or `password` comes with it, so the
  stored one is never sent somewhere new. This applies to `POST /app/test` too.
- A credential with `apiKeyFrom` or `passwordFrom` cannot be replaced here: a
  new `apiKey` or `password` is a 400 naming where it comes from. Change it
  in that file or variable, or in config.yaml. A `url` on another scheme, host
  or port is a 400 for these too.
- `apiKey`, `username` and `defaultUser` are trimmed. `password` is sent as is.
- `url: ""` means unchanged.
- GET shows a URL that carried credentials without them, and with a trailing
  slash if it has no path. Sending that URL back, with or without the slash, keeps the stored
  URL and its credentials. A URL with its own `user:pass@` replaces them, and
  any other different `url` replaces the stored one, credentials included.
- `timeoutMs` is a whole number from 1 to 2147483647.
- Send `safeWrite` or `destructive` on its own and the other keeps its value.
- Read-only fields from GET (`id`, `apiKeySet`, `apiKeyFrom`, `passwordSet`, `passwordFrom`, `type`, `name`)
  are accepted and ignored. Any other unknown field is a 400.
- A field that does not apply to the app's type, such as `password` on Radarr,
  is accepted and ignored for now.

## Endpoints

The examples use dummy names. `arr-mcp:6060` stands for wherever yours runs.
A `GET` is called like the example under [Authentication](#authentication),
with its own path.

### `GET /system/status`

The app, its version, and the MCP endpoint, built from the address you reached
it on.

```json
{
  "appName": "arr-mcp",
  "version": "1.51.0",
  "mcpUrl": "http://arr-mcp:6060/mcp"
}
```

### `GET /health`

A live connection test of every configured app, sorted by id. Same diagnosis the
dashboard and `get_stack_health` give: `version` when the app is up, and
`error` with `kind` and `detail` when it is not, and `remedy` when there is
one.

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
| `app` | Only records for this instance id, such as `radarr/hd`. An unknown id is refused with 400; a configured one that has logged nothing gives an empty list |
| `afterId` | Only records with an id above this. A whole number |
| `limit` | 1 to 300. Default 100 |

To poll for new lines, pass the highest `id` you have seen as `afterId`.

```bash
curl -H "X-Api-Key: $ARR_MCP_API_KEY" "http://arr-mcp:6060/api/v1/log?level=warn&limit=1"
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
    }
  ]
}
```

`app` is the record's instance (see [Conventions](#conventions)), or `null` for
records that belong to no instance. `fields` values are always strings.

### `GET /app`

Every configured instance, in alphabetical order.

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

Fields depend on the type. Transmission, qBittorrent and NZBGet have `username`
and `passwordSet`. Everything else has `apiKeySet`. Jellyfin, Plex and Seerr add
`defaultUser` and `allowOtherUsers`, and Plex alone adds `allowMetadataRepair`.
Cleanuparr, Reclaimerr and Dispatcharr are read-only, so their `safeWrite` and `destructive` are always `false`,
whatever was sent. Shelfmark alone can be added with no `apiKey`, for an install with no authentication. Any credentials in the URL are stripped.

### `GET /app/{type}` and `GET /app/{type}/{name}`

One instance, by its id: `/app/radarr` for an unnamed instance, and
`/app/radarr/hd` for a named one, even when it is the only one. Answers one
object, shaped like an entry of `GET /app`. An unknown app is a 404.

### `GET /settings/imdb`

The IMDb dataset: whether it is on, and when it was last loaded and how much it
holds. While it is off, the last three are `null`. Once it is on, `titles` and
`ratings` are counts, `0` before the first load, and `ingestedAt` stays `null`
until that load finishes.

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

```json
{
  "allowedHosts": [],
  "trustedProxies": [],
  "allowTokenInUrl": false,
  "oauthConfigured": false
}
```

### `GET /settings/media-servers`

Which media servers are configured, and `primary`, the one the tools default
to. With one server, that one is primary. With none, `primary` is `null`.

```json
{
  "primary": "jellyfin",
  "configured": ["jellyfin", "plex"]
}
```

### `GET /token`

The named MCP tokens. Never the tokens themselves: `fingerprint` is the first
eight hex characters after `sha256:` in the stored hash, so you can tell them
apart.

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
except Transmission, qBittorrent and NZBGet. The other fields are the ones in the
[update list](#updating-an-app): `username`, `password`,
`defaultUser`, `allowOtherUsers`, `timeoutMs`, `safeWrite`, `destructive` and
`allowMetadataRepair`.

A second instance of a type that allows several needs a `name`. If the first
one has no name yet, also send `renameExistingTo` to name it, because its id
changes. Answers 201 with the new app, shaped like an entry of `GET /app`.

Adding Plex beside Jellyfin, or the other way round, keeps the one already
there as primary. Change it with
[`PUT /settings/media-servers`](#put-settingsmedia-servers).

```bash
curl -X POST -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"type": "radarr", "name": "uhd", "renameExistingTo": "hd", "url": "http://radarr-uhd:7878", "apiKey": "abc123"}' \
  http://arr-mcp:6060/api/v1/app
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
accepted and ignored. Answers 200 with the same body as GET. The
[Concurrency](#concurrency) example calls it.

### `PUT /settings/mcp`

Changes `allowTokenInUrl`. `oauthConfigured` from GET is accepted and ignored.

`allowedHosts` is read-only here. It is accepted only if it equals the current
list, so a body you got from GET can be sent back. Anything else is a 400 with
`allowedHosts can only be changed on the config page.` The pin also gates the
config page, so a leaked key could otherwise lock the owner out.
`trustedProxies` follows the same rule, because a proxy on that list decides
which client a failed sign-in counts against and whether a request was https.

Answers 200 with the same body as GET.

```bash
curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"allowTokenInUrl": true}' http://arr-mcp:6060/api/v1/settings/mcp
```

### `PUT /settings/media-servers`

Sets `primary` to `jellyfin` or `plex`. It has to name a configured server, or
it is a 400. `configured` from GET is accepted and ignored. With one server,
naming it changes nothing. See
[Plex and Jellyfin together](configuration.md#plex-and-jellyfin-together).

Answers 200 with the same body as GET.

```bash
curl -X PUT -H "X-Api-Key: $ARR_MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"primary": "plex"}' http://arr-mcp:6060/api/v1/settings/media-servers
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

Revokes a token. It stops working at once. Answers 200 with `{}`. The name
matches regardless of case. An unknown name is a 404.

```bash
curl -X DELETE -H "X-Api-Key: $ARR_MCP_API_KEY" http://arr-mcp:6060/api/v1/token/companion
```
