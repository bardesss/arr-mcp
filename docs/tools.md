# Tools

Twenty-two of them. The first thirteen read; the last nine write, and are off
until you turn them on — see [writes](writes.md).

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
| `trigger_scan` | Rescan a library — it downloaded but still will not play |
| `set_monitoring` | Turn Sonarr monitoring on or off — a whole series, one season, or specific episodes |
| `remove_queue_item` | Get rid of this stuck or wrong download |
| `delete_media` | Remove this film or series, optionally from disk |
| `delete_episode_files` | Free disk from one Sonarr season or a handful of episodes, without touching the series |
| `respond_to_request` | Approve or decline what someone asked for |
| `delete_request` | Drop a request record entirely |
| `add_media` | Add this film or series and start looking for it |

The rest of this page is the shape of the answers: the fields whose meaning is
not obvious, and the places where a value is deliberately absent rather than
`false`.

## Every tool answers the same way

Every tool but `diagnose` takes `detail` (`minimal`/`standard`/`full`) and
`limit`, and reports `{ total, returned, offset, truncated }` — a truncated
answer always says so.

**Paging.** Every list tool also takes `offset`: page two of fifty is
`offset: 50`. `total` always counts the whole list rather than the window, so
`offset + returned < total` is how you know another page exists. `truncated`
answers a different question — *this is not the whole list* — and so stays
`true` on the last page of a walk, where everything you already read is behind
you. Pair `offset` with `sort` when the order matters: without one the order is
whatever the services returned, and an item can move between pages.

`stack_health` is the exception and takes no `offset`. One `limit` budget spans
its two lists, spent on failures before disks, so a single number could not say
which list it meant to skip into — and neither is one you page through.

Both halves of that contract are enforced against the services themselves, not
only in this server: `get_queue` asks Radarr and Sonarr for the whole queue
rather than accepting their ten-row default, and `get_requests` and
`get_indexers` push a status filter upstream where the service supports one, so
a filtered answer is not a filtered slice of an arbitrary window.

Tools spanning several services also report which ones they could not reach, and
how many results each contributed, so a long answer from one service can never
silently hide another.

`diagnose` takes a title, or an exact `service` plus `id`, and returns a verdict
rather than a list. With several instances of a service configured it also takes
`instance`, worded exactly as the write tools word it.

**Every answer comes twice: a sentence and a structure.** The summary line is
for a reader; `structuredContent` is the contract, and every tool declares its
shape as an `outputSchema` so a client knows what it will get before it calls.
Read `total` from there rather than parsing it out of "50 of 243 item(s)" —
that sentence is prose and may be reworded.

**A client can tell the reads from the writes without reading prose.** Every
tool carries a title and an annotation: `readOnlyHint` on the thirteen that only
read, and on the nine writes `destructiveHint`, taken from the same permission
tier the write gate itself runs on — so a tool cannot be gated as destructive
and advertised as safe. A client deciding what to auto-approve, or what to warn
about, reads those rather than guessing from twenty-two similarly-shaped
descriptions. `idempotentHint` is deliberately absent: the confirmation token is
single-use, so repeating a write does not repeat it, and neither answer would be
true.

**The server's `instructions`, returned at `initialize`, carry the rules that
hold between tools rather than inside one** — what `total` counts, and that a
write takes two calls. It is the only documentation every client sees; prompts
and resources are optional and support for them is uneven.

**An argument a tool does not have is refused, and the refusal lists the ones it
does have.** Dropping it silently would be worse than it sounds: the call
succeeds, the invented argument is gone, and the answer is indistinguishable
from one where it had been honoured. That is [#103] — an agent sent `offset` and
`source` to `get_library`, got a clean `200`, and reported the library as
unpaginable, never having learned that `limit` was the parameter it wanted.

[#103]: https://github.com/bardesss/arr-mcp/issues/103

## `diagnose`

It walks the whole chain — requested, managed, monitored, downloaded, indexed,
imported, scanned — and names the first thing that explains the absence, with
what to do about it.

No single service can answer this on its own. `get_library`'s
`presence: arr_only` alone would only suggest Jellyfin hasn't seen a file the
*arr believes exists; `diagnose` checks further, and may find Radarr itself has
no file yet and that neither the download queue nor an indexer rejection
explains why — which is the real answer, and the one that tells you what to do
next.

**It also works with services down.** Any step it could not check sets
`certain: false`, and the summary names what was missed: a confident verdict
across a hole is worse than no verdict.

## `stack_health`

With more than one instance of a service, each is reported separately.

It also reports `endpoints` — `instance`, `service` and `baseUrl` for every
configured instance, so a script knows where each one lives. It never carries a
key: **no tool in this server returns an API key**, because anything a tool
returns passes through a model's context. A script that needs credentials runs
beside `config.yaml` and imports `loadConfig`.

`endpoints` is absent at `detail: "minimal"`, alongside `permissions` — a URL is
no more a fault than a grant is.

## `get_library`

### What am I still waiting for

`has_file: false` with `monitored: true`.

Media no *arr manages is excluded from that answer rather than counted as
missing: nothing is going to fetch it, so it does not belong on a list of things
to chase.

### Filters that are films only, and why

`quality` is films only — a series has no series-level quality.

Rating filters are mostly films only too, because Sonarr carries one flat TVDB
rating rather than per-source scores. The exception is `imdb`, which the
[IMDb dataset](imdb.md) supplies for series as well — **and only it does**, so
asking for a series' IMDb rating with the dataset off finds nothing.

Asking for a combination that cannot exist returns a refusal explaining why, not
an empty list. Asking for one that needs the dataset says so in
`ratingCoverage.note` rather than reporting a bare zero.

### Sorting

`sort` exists because a filter alone cannot answer a superlative: with more
results than `limit`, the best-rated one may simply not be in the window
returned, and an answer drawn from an arbitrary fifty looks exactly like a right
one. Ordering happens before the limit is applied.

Items the chosen source has no rating for are excluded rather than ranked as
zero, and `ratingCoverage` says how many were set aside — a title nobody has
rated is not a bad title.

### Seasons, at `detail: "full"`

A series carries `seasons`, one entry per season:

| Field | From | Meaning |
| --- | --- | --- |
| `season` | Sonarr | 0 is specials, reported like any other season — filter `season > 0` if you don't want it |
| `watched`, `lastPlayed` | Jellyfin | Per-user watch state |
| `onDisk`, `aired`, `total` | Sonarr | `total` is TVDB's episode count by way of Sonarr, which is why this server needs no TVDB integration of its own |
| `complete` | both | `watched` has reached `total` |
| `monitored` | Sonarr | Its own per-season flag |

**`complete` is absent, never `false`,** whenever either half cannot be
compared — a series no *arr manages has no `total`, one Jellyfin has never seen
has no `watched` — and also for a season Sonarr reports with zero total
episodes, so an unannounced or empty season is never reported as finished.
Treating an absent `complete` as `false` would put a season you already finished
on a list of things still to watch.

**`monitored` is absent, never `false`,** for a series no Sonarr manages:
nothing is monitoring it, which is a different fact from monitoring being off.
It is the field to check before deleting a season's files, since deleting the
files of a monitored season makes Sonarr search for exactly what you removed.

### Where `seasons` appears

`get_library` omits `seasons` below `detail: "full"`.

`get_media_details` carries it at every detail level, on both of its forms:
asked by title it returns the merged record unprojected rather than a shaped
one, and asked by `service` plus `id` Sonarr's own view puts `seasons` in the
base payload, before the gate that adds episodes. `monitored` means the same
thing on both forms, so neither answer leaves you guessing about it.

### When Jellyfin's episode read fails

`degraded` gains `jellyfin:episodes`. Sonarr's half of `seasons` survives intact
(`onDisk`, `aired`, `total` and `monitored`); only the watch half (`watched`,
`lastPlayed`) and `complete`, which needs both halves, go missing. Film watch
state and `presence` are unaffected.

## `get_playback`

What can be continued comes from `/Users/{id}/Items/Resume`, Jellyfin's own
answer to the question. `/Items?IsResumable=true` looks like the right query,
but Jellyfin 10.11 silently ignores it and returns the whole library rather than
the resumable set.

The call sends an explicit `Limit=500`, so truncation is decided by `limit`
(default 50, like every other tool) and reported honestly through `truncated`,
rather than by however many rows an undocumented server page size happens to
hand back.

Each entry carries `percentComplete`, `positionSeconds` and `runtimeSeconds`.

To find films you are partway through: keep only `kind: "resume"`, keep entries
with no `seriesTitle`, `season` or `episode` (those three appear only on an
episode), then compare `percentComplete` yourself — arr-mcp does not filter by
how far in you are.

## Prompts and resources

Twenty-two tools do not tell you which one to reach for, and the questions
people actually ask are rarely one call.

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

`arr://health` is never cached (`ttlMs: 0`) and says so. A pinned
"sonarr: reachable" five hours after Sonarr fell over is worse than the tool
call it replaced: confidently wrong rather than merely absent.

Every resource also carries its own `as_of`, because a cache hint is advice a
client may ignore while a timestamp inside the content cannot be dropped.

## Two parameter spellings that will never be retired

Two parameters were inconsistent when the tool surface froze at 1.0, and both
old spellings keep working forever:

- `discover_media` takes `kind`, but still accepts `media_type`
- `get_library` takes `user`, but still accepts `watched_by`

They are no longer documented anywhere else, and nothing else will be quietly
retired that way.
