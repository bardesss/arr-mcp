# arr-mcp

One MCP server for your whole self-hosted media stack — not one per service.

Ask questions no single service can answer. *"Why isn't the film I requested on
Tuesday showing up in Jellyfin?"* spans Seerr, Radarr, Prowlarr, SABnzbd and
Jellyfin. arr-mcp correlates them and gives you the causal chain.

- **`diagnose` answers what no single service can.** It walks the whole
  chain — requested, managed, monitored, downloaded, indexed, imported,
  scanned — and names the first thing that explains why something isn't
  playable, even with a service down.
- **Tool output is treated as untrusted data, never instruction.** Release names
  from public indexers are attacker-controllable and flow straight into model
  context; arr-mcp fences them.
- **Writes are opt-in, previewed, and recorded.** Every write is off until you
  turn it on per service, shows you exactly what it would do before it does it,
  and lands in an audit trail either way.
- **A config page that diagnoses.** Add services from a browser, see what is
  broken and what to do about it, and read the logs and the write audit — no
  hand-edited YAML, no restart.

> ### Status: 0.9 — questions, not just tools
>
> Nineteen tools and no hint which to reach for is a menu nobody can read. This
> adds five prompts for the questions this stack actually gets asked — why isn't
> this playable, what needs my attention, what should I watch, what's the best
> thing I own, what happened this week — plus three resources, chiefly the list
> of instance ids every tool wants. Both degrade cleanly: client support for
> them is uneven, and **nothing is reachable only through them**. `get_library`
> also gains `has_file`, so "what am I still waiting for" is finally a question
> you can ask.
> See [the roadmap](#roadmap).

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
| `trigger_search` | Go look for this again |
| `remove_queue_item` | Get rid of this stuck or wrong download |
| `delete_media` | Remove this film or series, optionally from disk |
| `respond_to_request` | Approve or decline what someone asked for |
| `delete_request` | Drop a request record entirely |
| `add_media` | Add this film or series and start looking for it |

Every tool but `diagnose` takes `detail` (`minimal`/`standard`/`full`) and
`limit`, and reports `{ total, returned, truncated }` — a truncated answer
always says so. Tools spanning several services also report which ones they
could not reach, and how many results each contributed, so a long answer from
one service can never silently hide another. `diagnose` takes a title, or an
exact `service` plus `id`, and returns a verdict rather than a list — see
below.

`get_library` also answers **"what am I still waiting for"** — `has_file: false`
with `monitored: true`. Media no *arr manages is excluded from that answer
rather than counted as missing: nothing is going to fetch it, so it does not
belong on a list of things to chase.

`get_library`'s `quality` filter is films only — a series has no series-level
quality. Its rating filters are mostly films only too, because Sonarr carries
one flat TVDB rating rather than per-source scores; the exception is `imdb`,
which the [IMDb dataset](#imdb-ratings) supplies for series as well. Asking for
a combination that cannot exist returns a refusal explaining why, not an empty
list.

The first thirteen are reads. The last six write, and are gated as described
under [Writes](#writes) — off by default, previewed before they act, recorded
either way.

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

## Writes

Nothing writes to your stack until you say so, per service:

```yaml
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: "…"
    permissions:
      safe_write: true       # monitor, trigger a search — reversible
      destructive: false     # delete files, remove requests — not
```

Both default to **false**. A service you add by hand-editing YAML acquires no
write access by doing so. The tiers are ordered: `destructive: true` implies
`safe_write`, so you never have to reason about a config that permits deleting
a film but refuses to re-monitor it.

| Tool | Tier | Needs |
| --- | --- | --- |
| `trigger_search` | safe | `safe_write` |
| `respond_to_request` | safe | `safe_write` |
| `add_media` | safe | `safe_write` |
| `remove_queue_item` | destructive | `destructive` |
| `delete_media` | destructive | `destructive` |
| `delete_request` | destructive | `destructive` |

Approving and declining a request are one tool and deleting one is another,
because that is where the tier boundary falls: a verdict can be reversed, a
deleted record cannot. `delete_request` removes the *request*, never the media —
anything already downloaded stays on disk, and the preview says so before you
confirm rather than after.

`remove_queue_item` is destructive rather than safe because it deletes partial
data, and because `blocklist: true` durably teaches Radarr or Sonarr to refuse a
release — which is hard to notice and hard to undo months later, when the same
film mysteriously never grabs. SABnzbd and Transmission have no blocklist of
their own; ask for one there and the preview tells you it is being ignored
rather than silently accepting a flag that does nothing.

A write tool called without a confirmation token **does not write**. It resolves
the target, reports exactly what it would do, and hands back a token:

```
trigger_search { service: "radarr", id: "5" }
```

> Not applied yet. Ask radarr to search for releases for Alien (1979).
>
> - Queues a movie search on radarr for Alien (1979).
> - May grab and start downloading a release, which will appear in get_queue.
>
> To apply this, call trigger_search again with the same arguments plus
> `confirm` set to the token in `confirm_token`.

Tokens are single-use, expire after five minutes, and are cryptographically
bound to the exact operation and arguments previewed — a token issued for one
film cannot be replayed against another, and a token from a `delete_media`
preview that left files on disk cannot be used to wipe them. Restarting arr-mcp
invalidates any outstanding ones.

A destructive preview says what it costs in the units that matter:

```
delete_media { service: "radarr", id: "1535", delete_files: true }
```

> Not applied yet. Delete They Will Kill You (2026) from radarr, deleting
> 18.8 GB from disk.
>
> - Deletes 18.8 GB from disk. This cannot be undone.
> - Removes They Will Kill You (2026) from radarr, along with its monitoring
>   and history.

`dry_run: true` is the separate, terminal form: it describes the effect and
issues no token at all, so it can never turn into a write. It works even with
the tier switched off, and tells you which key you would need to set — that is
how you answer *"what would this do?"* without granting anything first.

Every attempt — applied, previewed, refused, dry run, or failed mid-flight —
is recorded in `config/audit.db` beside your `config.yaml`, with the resolved
target and the arguments. If that file cannot be written, writes are refused
rather than proceeding unrecorded; reads are unaffected.

Write tools take `service` and `id`, never a title. Titles are resolved fuzzily,
which is fine when the cost of being wrong is a wrong answer and not fine when
it is an action against the wrong film — use `get_media_details` or
`get_library` to get an id first. `add_media` takes an external id instead:
TMDB for Radarr, TVDB for Sonarr, both returned by `lookup_media` under `ids`.

`add_media` also needs a quality profile and a root folder. If your service has
exactly one of each, it uses them without asking. If it has several and you name
none, **it refuses and lists them** rather than picking:

> radarr has several quality profiles and none was named — Name one —
> available: Any (id 1); HD-1080p (id 4); HD-2160p (id 5); … Not guessing,
> because the wrong one is not obvious until the download finishes.

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

Tags are `X.Y.Z`, `X.Y`, `X` and `latest` for releases, plus `main` for
bleeding edge. Pin a minor — `:0.7` — if you would rather approve each new tool
surface yourself.

### First run

**1. Start it and open `http://<host>:6060`** — the bare host, no path. There is
nothing to read out of the container log.

```console
$ docker compose up -d
```

**2. Claim it.** Nobody has set this instance up yet, so the first page is a
setup form rather than a sign-in: choose a username and a password of at least
12 characters. You land on the dashboard already signed in.

> Do this **before** exposing the port. Until the instance is claimed, whoever
> loads that page first owns it — and it holds every service's API key. On a
> home LAN that is a walk from the terminal to the browser; behind a port
> forward it is a race with the internet.

**3. Add your services** on the Configuration page: **Add a service**, pick it,
paste its URL and API key, save. Saving applies immediately; there is no restart. Nothing is
configured until you do this, and a fresh install with no services answers
nothing — that is expected, not a fault.

Your MCP client goes to `http://<host>:6060/mcp`, with the bearer token shown on
the dashboard. No password is ever written to a log, so `docker logs` is for
diagnosing the container, not for retrieving credentials.

Everything the UI does is still just `config.yaml`, and editing it by hand
remains supported:

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

Each service also takes an optional `permissions` block — both flags default to
false, so the config above is read-only. See [Writes](#writes).

All eight are supported: `radarr`, `sonarr`, `prowlarr`, `bazarr`, `jellyfin`,
`seerr`, `sabnzbd`, `transmission`. Configure only what you run — anything you
leave out is simply absent, not broken.

If `jellyfin` is configured, `default_user` is required, not optional flavour:
`get_library`, `get_media_details` (its title-query form) and `diagnose` all
join Radarr/Sonarr against Jellyfin's per-user watch state, and without a
resolvable user they fail outright, naming `default_user` and how to set it,
rather than silently answering as if Jellyfin were not there. Leaving
`jellyfin` out of `config.yaml` entirely is still fine — those tools just work
from Radarr/Sonarr alone.

A misspelled key, an unknown service, or an `api_key` on Transmission fails at
startup with the offending field named, rather than being silently ignored.

Changes saved from the config UI take effect immediately — every field,
including `allowed_hosts`. A change you make by hand-editing the file still
needs a restart, because nothing is watching the file; the UI reloads because
it knows it just wrote.

One thing to be careful with: pinning `allowed_hosts` applies at once, so a
wrong hostname locks you out of the page you would fix it from. Recover by
editing `config.yaml` by hand and restarting.

### Multiple Radarr, Sonarr and Bazarr instances

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

```
add_media { service: "radarr", external_id: "550" }
```

> radarr has 2 instances configured, so "radarr" alone does not say which —
> pass `instance` with one of: "4k", "hd".

That means **adding a second instance changes how existing prompts behave**:
requests that used to be unambiguous start asking which instance you meant. That
is deliberate, and it only affects writes.

**Permissions are per instance**, so `safe_write` on `hd` and nothing on `4k` is
a configuration you can express — each entry carries its own `permissions`
block.

Only Radarr, Sonarr and Bazarr take a list. The other five are one each:
Prowlarr feeds every *arr from one place, Seerr connects to your instances
itself, and a second download client is a different kind of setup from a quality
tier.

### IMDb ratings

Ratings across this stack are inconsistent, and for series they are absent.
Radarr returns a per-source map, so a film can carry IMDb, TMDB, Rotten
Tomatoes and Metacritic scores at once. Sonarr returns a single unlabelled
number, which arr-mcp can only honestly record as TVDB's — so **no service here
can tell you a series' IMDb rating**, and asking `get_library` for one used to
be refused outright.

Switching on IMDb's daily dataset fixes that:

```yaml
metadata:
  imdb:
    enabled: true
```

No account, no API key, nothing sent anywhere. Your container downloads three
of IMDb's published files each day and keeps them in a local SQLite database
beside the audit log. Films and series both get a rating, and so do things you
do **not** own — `lookup_media` can rate something before you decide to add it.

```
get_library({ kind: "series", watched: false, rating_source: "imdb",
              sort: "rating", limit: 10 })
```

> The ten best-rated series you have not watched.

`sort` arrived with this, because a filter alone cannot answer a superlative:
with more results than `limit`, the best-rated one may simply not be in the
window returned, and an answer drawn from an arbitrary fifty looks exactly like
a right one. Ordering happens before the limit is applied. Items the chosen
source has no rating for are excluded rather than ranked as zero, and
`ratingCoverage` says how many were set aside — a title nobody has rated is not
a bad title.

Two honest limits. The dataset keys on IMDb ids, and Radarr leads with TMDB
ids, so titles carrying no IMDb id are never matched — they come back unrated,
and counted. And the first ingest takes a while on a NAS; everything answers
exactly as it did before until it lands, and the dashboard says when it has
finished.

`discover_media` also falls back to the dataset when Seerr is not configured,
where it previously returned nothing. Seerr still answers whenever it is
present — it knows what is trending and requestable, which a static catalogue
does not.

## Prompts and resources

Nineteen tools cover what arr-mcp can do. They do not tell you which one to
reach for, and the questions people actually ask are rarely one call.

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
| `arr://instances` | Every instance id and what it may do — the values other tools accept as `instance` |
| `arr://health` | A stack verdict, stamped with when it was taken |
| `arr://library/summary` | Total, on disk, still wanted |

**Client support for both is uneven, so nothing is reachable only through
them.** A prompt is a sequence of tool calls the model could have made anyway,
and every resource mirrors something a tool already returns. On a client that
surfaces neither, arr-mcp is exactly as capable as it was — you just have to
know what to ask.

`arr://health` is never cached (`ttlMs: 0`) and says so. A pinned "sonarr:
reachable" five hours after Sonarr fell over is worse than the tool call it
replaced — confidently wrong rather than merely absent. Every resource also
carries its own `as_of`, because a cache hint is advice a client may ignore
while a timestamp inside the content cannot be dropped.

## Config UI

`http://<host>:6060`

| Page | What it is for |
| --- | --- |
| Dashboard | Every service tested live, plus disk space, failed health checks, library scan staleness, and the bearer token for your MCP client |
| Configuration | Add, edit, test and remove service instances one at a time; change credentials |
| Logs | Three streams — all activity, problems only, or one service |
| Write audit | Every write attempt — applied, previewed, refused or failed |

**Connection tests diagnose rather than pass or fail.** A service that is down
says what is wrong and what to do about it — the same `kind`, `detail` and
`remedy` the MCP tools return — instead of showing a red cross you then have to
investigate. The dashboard answers the same four questions `stack_health` does,
from the same code: is it reachable, is anything reporting a problem, is a disk
filling up, and when did each library last finish a scan. A stale scan is the
usual reason something downloaded is still not playable.

**Disk space is listed per filesystem, not per mount.** Services in one stack are
containers over the same host disks, so each of them reports the array, its own
root and its config volume separately — ten rows to tell you about two disks. The
dashboard groups them back together and names the instances that can see each
one, emptiest first.

**Secrets never come back out.** API keys, the Transmission password and the UI
password all render as empty fields meaning *unchanged*, so a saved page or a
screenshot cannot carry them. The bearer token is the deliberate exception —
handing it to your MCP client is the point — and it is masked until you ask.

**Your password manager leaves the Configuration page alone.** None of its
fields is a `password` input, because that is the one thing that makes a browser
read a card as a login form and refill the URL and API key on every load. They
are masked in CSS instead, and carry each manager's own opt-out attribute. The
sign-in page is untouched — that one *should* be filled.

**The dashboard gives you the whole MCP connection.** It shows the endpoint as
an absolute URL, built from the address you reached the page on — so it is
already correct behind a reverse proxy, and there is nothing to assemble by
hand. **Copy client config** puts a ready-to-paste JSON block on your clipboard
with the endpoint and token filled in. That block is assembled in your browser
at the moment you click, never rendered into the page, so the screenshot
property above still holds.

**The Configuration page starts empty.** It shows a card per instance you have
actually configured, in alphabetical order, and an **Add a service** button —
not eight blank fieldsets for services you do not run. Each card saves on its
own, so editing your 4K Radarr cannot disturb the HD one.

**Add a service** opens a dialog that only asks what the service needs: pick
Transmission and it wants a username and password, pick anything else and it
wants an API key. Services that can only have one instance drop out of the list
once you have that one, so the picker never offers a choice that ends in
"already configured". With scripting off the dialog is the plain form it used to
be, every field showing, and the server still refuses what does not make sense.

**Test** tries the URL and key *as they are on screen*, saved or not, and tells
you what came back — reachable and how fast, or what is wrong and what to do
about it. Nothing is written to disk, so it is safe to try a URL you are unsure
of. It sits in the **Add a service** dialog, where you can check a new service
before it is added at all, and on every card, where a blank key still means
unchanged — so testing a card you have not touched tests what is already
configured.

**Jellyfin and Seerr suggest their own users.** The default-user field is backed
by the real list, fetched from the service when the page loads, so the name you
save is one the service actually knows rather than one you typed from memory. If
the service does not answer, the field stays a plain text box and says so — you
can always configure a service that is currently down.

Adding a second Radarr, Sonarr or Bazarr asks you to name the one you already
have, and says why: the name becomes part of the id, and that id is the
permission key, the audit column, and what your agent passes. Removing an
instance asks once before it goes, because its API key is not recovered by
re-adding it.

**Logs are a ring buffer**, kept beside your config and capped, so a chatty
service cannot fill the disk. Full history stays in `docker logs`.

Sign-in is a username and password you choose the first time you open the UI.
Only a scrypt hash is stored, so the password cannot be recovered — but it can
be replaced: delete the `password_hash` line from `config.yaml` and restart, and
the setup page comes back exactly as it does on a fresh install. An instance
with no `password_hash` is *unclaimed*, and every page redirects to setup until
someone claims it.

The UI is served over plain http on your LAN, like the services it manages.
Put it behind a reverse proxy with TLS if it needs to leave the LAN, and pin
`allowed_hosts` if you do.

## Roadmap

| Version | Delivers |
| --- | --- |
| 0.1 / 0.2 | Walking skeleton: stateless MCP transport, bearer auth, Radarr, `stack_health` |
| 0.3 | The remaining seven service adapters and ten read tools |
| 0.4 | Cross-service correlation: identity resolver, three-way library join, `diagnose` |
| 0.5 | Writes: permission tiers, `dry_run`, write audit, per-call confirmation |
| 0.6 | Web config page: dashboard, diagnosing connection tests, log streams, config editing with hot reload |
| 0.7 | Multiple Radarr, Sonarr and Bazarr instances — an HD and a 4K stack read as one library |
| 0.8 | A local IMDb dataset: ratings that are consistent across films and series, and orderable |
| 0.9 | Prompts and resources: the questions worth asking, and the ids every tool wants |
| 1.0 | The tool surface settles: security, consistency and dead-code audit |

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
| [yaml](https://eemeli.org/yaml/) | reading `config.yaml` |
| [TypeScript](https://www.typescriptlang.org) | the language |

**The data it reads**, when you enable the IMDb dataset:

> Information courtesy of
> [IMDb](https://www.imdb.com) ([datasets](https://developer.imdb.com/non-commercial-datasets/)).
> Used with permission.

Those datasets are published for **personal and non-commercial use**. arr-mcp
never redistributes them and ships no prebuilt copy — your own container
downloads them, for your own use, only if you switch the dataset on. It is off
by default.

If you find arr-mcp useful, consider supporting the services above first.

## Licence

[MIT](LICENSE)
