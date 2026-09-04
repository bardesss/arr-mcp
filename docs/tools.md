# Tools

Thirty-four of them. The first seventeen read; the last seventeen write, and are
off until you turn them on — see [writes](writes.md).

| Tool | Answers |
| --- | --- |
| `diagnose` | Why is this not playable? |
| `stack_health` | Is anything broken, out of disk, or not scanning? |
| `search_media` | What do I have, what exists, what can I get? |
| `get_media_details` | Everything about one item |
| `get_library` | What's in my library — joined across Radarr, Sonarr and Jellyfin, and where the three disagree |
| `get_queue` | What is downloading, across all four download paths |
| `get_history` | Why did last night's download fail — grabbed, imported, failed, deleted, and what SABnzbd and Bazarr did |
| `get_wanted` | Which episodes of a show are missing, and what has a file below cutoff |
| `get_releases` | What an interactive search actually found, rejects included |
| `get_calendar` | What is due, and what just aired |
| `get_subtitles` | What is missing subtitles, and which providers are throttled |
| `get_playback` | What am I watching, and what can I continue |
| `get_indexers` | Which indexers are healthy, and what they recently rejected |
| `get_requests` | What has been requested, and what is still pending |
| `lookup_media` | Tell me about this, without adding it |
| `discover_media` | What exists in this genre, year, or rating band |
| `trigger_search` | Go look for this again — the whole thing, one season, or specific episodes |
| `trigger_scan` | Rescan a library, refresh or rename one item, or import a download that never landed |
| `trigger_subtitle_search` | Go and find the subtitles this is missing, now |
| `set_monitoring` | Turn Sonarr monitoring on or off — a whole series, one season, or specific episodes |
| `remove_queue_item` | Get rid of this stuck or wrong download |
| `clean_queue` | Clear out completed downloads whose film or series no longer exists |
| `delete_media` | Remove this film or series, optionally from disk |
| `delete_episode_files` | Free disk from one Sonarr season or a handful of episodes, without touching the series |
| `respond_to_request` | Approve or decline what someone asked for |
| `delete_request` | Drop a request record entirely |
| `add_media` | Add this film or series and start looking for it |
| `update_media` | Change the profile, folder, monitoring or tags of something already there |

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

**The tool list is cacheable for an hour.** On the 2026-07-28 protocol
revision every list result carries a `ttlMs`, and `tools/list`,
`prompts/list` and `resources/list` say an hour. They can, because the lists
are static by construction: every tool, prompt and resource is registered
unconditionally, so nothing a configuration edit does can change what is in
them. A client that honours the hint stops reloading the whole surface every
session. The three resources are different — each carries its own hint, and
`arr://health`'s is deliberately zero, because a pinned health snapshot
saying a dead service is fine is worse than no snapshot at all. Clients on the
2025 protocol see none of this and are unaffected.

**A client can tell the reads from the writes without reading prose.** Every
tool carries a title and an annotation: `readOnlyHint` on the seventeen that only
read, and on the seventeen writes `destructiveHint`, taken from the same permission
tier the write gate itself runs on — so a tool cannot be gated as destructive
and advertised as safe. A client deciding what to auto-approve, or what to warn
about, reads those rather than guessing from thirty-four similarly-shaped
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
`presence: arr_only` alone would only suggest the media server hasn't seen a
file the *arr believes exists; `diagnose` checks further, and may find Radarr itself has
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

### What each instance will accept, at `detail: "full"`

`options` lists, per Radarr/Sonarr instance, the `qualityProfiles`,
`rootFolders` and `tags` it actually has. These are the values `add_media` and
`update_media` refuse to guess at: with more than one profile they insist you
name which, and this is where the names come from. Only at `full`, because it
is three extra calls per instance and it answers "what may I choose", not "is
anything broken". An instance whose profile list cannot be read is named in
`degraded` and left out of `options` — the rest of the answer stands.

### Did that command finish?

`commands` is every **followable** task a service has queued or running, plus
anything it finished in the last fifteen minutes: `commandId`, `name`, `status`
(`queued`, `started`, `completed`, `failed`), and the times. It is the
follow-up `trigger_search` and `trigger_scan` never had — both hand back a
command id and return immediately, and until now the only way to know whether
one had finished was to wait and re-read the queue.

Followable means the tasks this server can start — searches, scans, refreshes,
renames, imports, the Prowlarr sync. A live instance also runs its own
housekeeping every minute, and it is left out: measured on a quiet stack the
unfiltered window held 37 rows, every one of them a poller, which is how the
one row you asked about gets lost. Filtering on the command's `trigger` would
not have helped — Radarr reports its own per-minute refresh as `manual`.

**A command that is not in the list has finished.** The fifteen-minute window
is what makes that readable rather than merely true: a search you started a
minute ago is still there with its outcome. Older than that is history, which
`get_history` answers. Absent at `detail: "minimal"` — a running command is
not a fault — and bounded like `scans` rather than sharing the `limit` budget.

## `get_library`

### The ids a write needs

Every merged record carries, under `acquisition`:

| Field | What it is |
| --- | --- |
| `id` | The managing service's own id, as an integer string. This is what `delete_media`, `trigger_search`, `set_monitoring`, `get_releases` and `update_media` take as `id`. |
| `status` | The service's own status word — `continuing`, `ended` or `upcoming` from Sonarr; `announced`, `inCinemas` or `released` from Radarr. Passed through, never normalised: the two vocabularies describe different things. |
| `qualityProfileId`, `qualityProfile` | The profile it grabs against, and its name. |
| `path` | Where the service keeps it on disk. |

and, under `playback`, `itemId` — the media server's own id, which is what
`set_watched` takes.

Before this, a caller had the external ids and nothing a write would accept,
so answering "delete this" meant a second `search_media(source: "library")` hop
to find the id for a title `get_library` had just returned.

**A present `qualityProfileId` with no `qualityProfile` means the profile list
could not be read** — not that the item has no profile. The profile names are
one extra call per library build, cached beside it, and a failure there degrades
to the id rather than taking the library with it.

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
| `watched`, `lastPlayed` | media server | Per-user watch state |
| `onDisk`, `aired`, `total` | Sonarr | `total` is TVDB's episode count by way of Sonarr, which is why this server needs no TVDB integration of its own |
| `complete` | both | `watched` has reached `total` |
| `monitored` | Sonarr | Its own per-season flag |

**`complete` is absent, never `false`,** whenever either half cannot be
compared — a series no *arr manages has no `total`, one the media server has
never seen has no `watched` — and also for a season Sonarr reports with zero total
episodes, so an unannounced or empty season is never reported as finished.
Treating an absent `complete` as `false` would put a season you already finished
on a list of things still to watch.

**`monitored` is absent, never `false`,** for a series no Sonarr manages:
nothing is monitoring it, which is a different fact from monitoring being off.
It is the field to check before deleting a season's files, since deleting the
files of a monitored season makes Sonarr search for exactly what you removed.

### Where `seasons` appears

`get_library` omits `seasons` below `detail: "full"`.

A series at `detail: "full"` carries `episodes` on **either** form. Asked by
`service` plus `id`, they come from that service's own view; asked by title,
they are fetched from the Sonarr that manages the series, using
`acquisition.id`. A series no Sonarr manages therefore has none — there is
nothing to ask. An episode read that fails leaves the merged record intact and
simply omits them: the record is the answer, and the episodes are the extra.

`get_media_details` carries `seasons` at every detail level, on both of its forms:
asked by title it returns the merged record unprojected rather than a shaped
one, and asked by `service` plus `id` Sonarr's own view puts `seasons` in the
base payload, before the gate that adds episodes. `monitored` means the same
thing on both forms, so neither answer leaves you guessing about it.

### `lastPlayed`, and what its absence means

A season row carries `lastPlayed` when the media server has a play date for
anything in that season, and **omits it when nothing in the season has been
played**. Absent means never played — it is not an unknown. `watched: 0` with
no `lastPlayed` is the ordinary shape of a season nobody has started.

### When the media server's episode read fails

`degraded` gains `{service}:seasons` — `jellyfin:seasons` on a Jellyfin
stack, `plex:seasons` on a Plex one. Sonarr's half of `seasons` survives intact
(`onDisk`, `aired`, `total` and `monitored`); only the watch half (`watched`,
`lastPlayed`) and `complete`, which needs both halves, go missing. Film watch
state and `presence` are unaffected.

## `get_playback`

`scope` picks which of three Jellyfin reads answers the call, and defaults to
`active` — every existing caller sees the same output it always has.

`scope: "active"` (the default): what can be continued comes from
`/Users/{id}/Items/Resume`, Jellyfin's own answer to the question.
`/Items?IsResumable=true` looks like the right query, but Jellyfin 10.11
silently ignores it and returns the whole library rather than the resumable
set. Each entry carries `percentComplete`, `positionSeconds` and
`runtimeSeconds`.

To find films you are partway through: keep only `kind: "resume"`, keep entries
with no `seriesTitle`, `season` or `episode` (those three appear only on an
episode), then compare `percentComplete` yourself — arr-mcp does not filter by
how far in you are.

`scope: "next_up"`: the next unwatched episode of every series a user has in
progress, from `/Shows/NextUp` — Jellyfin's own answer to "what should we watch
tonight," one row per series. `kind: "next_up"`; `title` is the episode, and
`seriesTitle`, `season` and `episode` say which show and where.

`scope: "history"`: recently watched movies and episodes, newest first, from
a sort-by-`DatePlayed` read over played items. `kind: "watched"`; `lastPlayed`
carries the timestamp and survives even at `detail: "standard"`, since it is
the one field this scope exists to answer.

Every scope sends an explicit `Limit=500` (`next_up` gets whatever Jellyfin
reports, which does not grow unbounded), so truncation is decided by `limit`
(default 50, like every other tool) and reported honestly through `truncated`,
rather than by however many rows an undocumented server page size happens to
hand back.

The tool is not Jellyfin-specific in its plumbing: it reads any adapter that
implements `PlaybackCapable`, and the summary line names whichever media server
failed. The endpoint detail above is Jellyfin's; Plex answers the same three
scopes from `/status/sessions`, `/library/onDeck` and
`/status/sessions/history/all` — only one media server is ever configured, so
the two never compete for an answer.

Plex's `/library/onDeck` mixes resume and next-up rows with nothing marking
which is which, so `active` and `next_up` split it by `viewOffset`: non-zero
reads as resume, zero or absent as next-up. That split is unverified against a
live server.

**Plex answers for one user only.** A local `X-Plex-Token` is scoped to a
single Plex account, so every Plex row here is that account's — reading anyone
else's watch state would mean going through plex.tv, which this adapter's
design refuses. Jellyfin's `allow_other_users` has no Plex equivalent, for the
same reason — `services.plex.allow_other_users: true` is refused at config
load.

**Known limitation:** `listUsers` reports whichever account `/accounts` names
as id `1`, on the assumption that a locally-issued token belongs to the server
owner. A token that instead belongs to a managed user would be mislabelled and
filtered as the owner. This has not been verified against a managed-user
token; if you run one, a config UI issue with what `/accounts` actually
returns for it would help.

`set_watched`, below, remains Jellyfin-only: the Plex adapter is read-only.

### When no media server is configured

Every scope answers zero, and `degraded` stays empty — an unconfigured service
is not a degraded one, so there is nothing to name. That pair reads exactly like
a quiet evening, which is the wrong answer to a question nobody asked. `note`
carries the difference, and the summary line shows it *instead of* the counts
rather than after them: a correction printed behind "0 item(s) playing now"
leaves the claim standing.

`get_library` sets the same `note` for the same reason — with no media server,
its `presence` field reports `unknown` for everything, which is a gap in the
join rather than a finding about the library.

## `get_queue`

Each Radarr or Sonarr row carries `downloadId`, the download client's own id
for that grab. It is what `trigger_scan`'s `import` action takes, and it is the
link between "this is stuck at `importBlocked`" and doing something about it.

## `get_history`

`get_queue` only ever sees what is still in-flight — once a download fails,
imports, or its file gets deleted, it leaves the queue and `get_queue` has
nothing to say about it. `trigger_search` cannot fill that gap either: it hands
back a command handle, and Radarr and Sonarr do not report a search's outcome
through it. `get_history` merges Radarr's and Sonarr's own history logs with SABnzbd's and
Bazarr's, and is the only tool that can answer "why did last night's download
fail".

Both services' events are normalised to one vocabulary — `grabbed`,
`imported`, `failed`, `deleted`, `renamed`, `ignored` — because they mostly
already agree: both spell a grab `grabbed` and an import
`downloadFolderImported`. The one place they diverge is deletion,
`movieFileDeleted` versus `episodeFileDeleted`, and that is normalised too.
Upstream's own spelling survives as `rawEvent`, and an event this server does
not yet recognise becomes `unknown` rather than being dropped.

A failure's `reason` comes straight from the download client and is fenced
like any other untrusted string — it is not translated, and on a non-English
setup it will not read as English.

### The two services below the *arrs

**SABnzbd** contributes its own history: what happened to a download after it
left the queue, one layer below the *arr that asked for it. When Radarr says it
grabbed something and nothing ever arrived, the client's own failure message is
the answer, and it is here. Its rows map onto the same vocabulary — `Completed`
becomes `imported`, `Failed` becomes `failed` — and carry the `fail_message`
as `reason`.

**Bazarr** contributes `subtitle` rows: what it actually downloaded, and from
which provider (in `quality`, as `language · provider`). It is its own event
type on purpose — a downloaded subtitle is not an `imported` grab, and calling
it one would put it in the answer to "what did Radarr import last night".

Both refuse a `service` + `id` scope rather than answering an empty list:
neither knows what a Radarr movie id or a Sonarr series id means, and an empty
answer would read as "nothing ever happened to that film". Bazarr's rows are
also dropped rather than dated when its timestamp cannot be read — it has
shipped two different shapes and neither is ISO 8601, and this list is sorted
and `since`-filtered as plain strings, so a guessed date would not merely
mislabel one row, it would reorder the answer.

Pass `service` and `id` together to scope to one movie or series, via a
`movieIds`/`seriesIds` filter on the same paged endpoint the unscoped read
uses — not the per-item endpoint (`/api/v3/history/movie`), which answers a
bare array rather than the paginated envelope this server needs.
`id` without `service` is refused: Radarr's movie ids and Sonarr's series ids
are different namespaces, and a shared number would otherwise merge two
unrelated items' history into one answer.

`mediaId` is the movie or series id — hand it straight to `get_media_details`
or `trigger_search`. Sonarr also reports `episodeId` separately; it is never
folded into `mediaId`.

## `get_wanted`

`get_library` can say a movie is missing — `monitored` with no file — but a
season's aggregate counts cannot say *which* episodes of a show are missing,
and neither tool can say what already has a file but not yet the quality a
profile wants. `get_wanted` answers both, straight from Radarr and Sonarr's
own wanted lists.

`scope` is required, with no default: `missing` is monitored items with no
file at all; `upgradable` is monitored items that have a file but sit below
the quality profile's cutoff. The two answer different questions, and
defaulting to one would silently hide the other.

Radarr's wanted rows are movies. Sonarr's are episodes, and the shapes differ
in what matters most: `id` always names the **series** — the id
`trigger_search` and `get_media_details` take — never the episode, even
though the episode is what the row is actually about. `title` names the show;
`season`, `episode` and `episodeTitle` describe which episode of it. Radarr
rows never set the three episode fields.

Sonarr's missing list is monitored-only, which matches what "wanted" means
here — an unmonitored gap is not something anyone asked for, and it will not
appear in this list.

`detail: "minimal"` drops `episodeTitle` and `airDate`, keeping the identity,
`season`/`episode` and `monitored`. Neither field is grab-plumbing the way
`get_history`'s `guid` is — there is nothing to trim between `standard` and
`full` here, since every field is one a reader wants.

## `get_releases`

`trigger_search` asks Radarr or Sonarr to look for a release, but hands back
only a queued command — it cannot show what was found, so nothing can
actually be picked. `get_releases` runs the same interactive search Radarr
and Sonarr's own web UI does and returns every candidate, so a model can
compare them and — once a grab tool exists — choose one.

`service` and `id` are both required: this searches one movie or series,
never merges across services the way `get_history` and `get_wanted` do.
`season` is Sonarr-only, and passing it to a Radarr search is refused rather
than silently dropped.

Rejected releases are returned, not filtered out. A live capture found
*every* candidate rejected on both a Radarr and a Sonarr search — 2 of 2 and
516 of 516 — almost always because the library already held a file at an
equal or higher quality score. That is the ordinary outcome, and a tool that
hid rejects would have answered empty both times. Each row carries
`rejected` and the `rejections` upstream gave, fenced like every other
release-supplied string.

`guid` and `indexerId` travel together — that pair is what a future grab
tool will bind a chosen release to. `seeders` is torrent-only and is absent,
not zero, on a usenet result, which has no seeder count to report.

`detail: "full"` keeps `guid`, `indexerId` and `rejections`. `standard` (the
default) trims all three — the largest response on this server's surface can
carry hundreds of rejected rows, each with its own reasons, so the token
budget guarantee holds at the default detail level rather than at `full`,
which is documented as intentionally the biggest a caller can ask for.
`minimal` keeps only `service`, `indexer`, `title`, `quality` and `rejected`.
`guid` is never fenced, since a grab tool needs it verbatim, but it is still
stripped of the same dangerous code points fenced text is and length-capped —
an indexer chose it, and it is not trusted any more than a release title is.

This call is slow. Radarr and Sonarr poll every configured indexer
synchronously before answering, and a live capture measured a Sonarr season
search at 14.3 seconds — a cold search across more indexers can run longer.
The tool's own per-call timeout is 120 seconds, well past the 10-second
default every other call uses, specifically so a real search has room to
finish rather than being cut off. A long wait here is not a hang; retrying
it starts a second full indexer sweep.

## `grab_release`

The write half of `get_releases`. Takes `guid` and `indexer_id` from a
`get_releases` row verbatim and tells Radarr or Sonarr to grab that one
release — "not that one, the 1080p remux".

Safe tier, not destructive: a grab starts a download, and a download comes
back off with `remove_queue_item`. Nothing on disk is lost.

Previewing is slow, and deliberately so. The preview re-runs the interactive
search before it will issue a token, which polls every indexer again and can
take tens of seconds. It buys two things. Indexer results expire, and a bare
grab of an expired guid answers a 404 that is indistinguishable from a wrong
base path — the re-search turns that into *"that release is no longer on
offer, call get_releases again"*. And it puts the release's real name in the
preview: "grab release abc" is not something a person can approve.

The confirmation token binds to **both** `guid` and `indexer_id`. That pair
is what identifies a release, and the candidate list is written by indexers,
so a search running between the preview and the confirmation must not be able
to swap which release the confirmation applies to. A token issued for one
guid is refused for another, and the same for the indexer.

A release Radarr or Sonarr rejected on its own criteria can still be grabbed
— that is most of what this tool is for — but the preview says which
rejections are being overridden before you confirm.

### A magnet, straight to the client

Instead of `guid` and `indexer_id`, this tool takes a `magnet` link addressed
to `transmission` or `qbittorrent`. Sending both is refused rather than
resolved: they are different ways to start a download.

This is the one place in the server where a URI the caller supplies causes a
download, so the link is validated here rather than passed on — a magnet must
start `magnet:?` and carry `xt=urn:btih:<hash>`. The preview names the hash,
because the rest of a magnet is tracker parameters nobody can weigh.

It skips Radarr and Sonarr entirely, and the preview says what that means:
nothing vetted the release — no indexer, no quality profile — and nothing will
import it into your library afterwards, because no *arr knows it exists. A
torrent the client already has is reported as a duplicate rather than an error;
that is the state you asked for.

## `request_media`

Asks Seerr for something, the way a household member would through its web
UI: it enters the approval queue and counts against that user's quota.

The line against `add_media` is the whole reason both exist. `add_media`
writes straight into Radarr or Sonarr — no approval, no quota, and it needs
*that service's* write permission. `request_media` goes through Seerr and
needs Seerr's. Asked to "request" something, a model should reach for this
one.

`media_id` is a TMDB id. Seerr resolves the TVDB id itself, so there is no
second id to supply. For a series, `seasons` defaults to every season — a
live Seerr answers HTTP 500 for a tv request carrying no seasons at all, so
"all" is sent explicitly rather than omitted. Passing `seasons` for a film is
refused rather than ignored.

Already-requested is a **no-op**, not an error and not a second request. That
check happens here because Seerr does not do it: requesting the same media
twice creates two rows on a live 3.4.1.

`user` names whose quota and approval trail the request lands in, and
requesting as anyone but `default_user` needs
`services.seerr.allow_other_users` — the same gate `get_requests` and
`respond_to_request` apply. Without it, one household member's assistant
could spend another's quota.

## `get_requests`

At `detail: "full"` the answer also carries `issues`: what your users have
reported as broken, each with its newest comments. Seerr numbers both the kind
(`video`, `audio`, `subtitle`, `other`) and the state (`open`, `resolved`);
both are mapped to words here, because a model handed `issueType: 2` cannot say
what is wrong with the film.

`issues` is a sibling list rather than a second kind of `items` — the same
shape `get_indexers` uses for its rejections — so `items` keeps meaning exactly
what it always has. Comments are the users' own text and are fenced, and capped
at the newest few per issue. Unlike the requests, issues are not scoped to one
user: they are what the household has reported.

A Seerr that cannot answer for issues still answers for the requests, and does
not report itself degraded for it.

## `get_blocklist` and `remove_blocklist_item`

The question that sends people here is "it keeps finding the same release and
never downloading it". `get_history` shows that as a grab followed by a
failure, over and over, and explains none of it. The blocklist does: Radarr
and Sonarr record what they will not grab again, and why — usually in the
download client's own words.

Rows carry `mediaId` for `get_media_details` and `id` for
`remove_blocklist_item`, and are newest first, because a blocklist is read to
explain something that has just gone wrong.

`remove_blocklist_item` withdraws one refusal, so the release can be grabbed
again. Safe tier: nothing on disk changes, and the inverse already exists —
`remove_queue_item`'s `blocklist: true` puts a release back on the list.

Its preview reads the live blocklist first, and that is not a courtesy. Both
services answer a `DELETE` of a blocklist id that **does not exist** with
success — probed against a live Radarr and a live Sonarr — so a stale id
would otherwise be reported as removed when nothing had happened. It is the
same trap `remove_queue_item` documents, and it is checked the same way.

## `set_watched`

The write half of `get_playback`. Marks a film, series, season or episode
watched or unwatched in Jellyfin.

`item_id` is a **Jellyfin** item id, and that constraint is deliberate rather
than incidental. Jellyfin's own ids never enter the library index —
`listUserLibrary` carries TMDB, TVDB and IMDb ids only — so an id here can
only have come from the `itemId` `get_playback` reports or from a jellyfin
hit in `search_media`. A Radarr or Sonarr id is a small integer and is
refused before any network call, rather than becoming a 404 that names
nothing.

A series id with `season` marks that season. The preview reports the **number
of episodes**, not just the season number: "marks season 2 watched" is not
something anyone can weigh. It counts only the episodes that would actually
change, so re-running it on a mostly-watched season says so.

Safe tier, with one caveat stated in every preview: unmarking and re-marking
restores the watched flag but **not** the original play date or resume
position. That history is not recoverable.

`user` names whose watch state changes; anyone but `default_user` needs
`services.jellyfin.allow_other_users`.

## `pause_downloads`

The bandwidth answer: "stop downloading for an hour". Pauses or resumes one
download client — SABnzbd, Transmission or qBittorrent — or one item in its
queue when `id` is given.

`action: "limit"` throttles instead of stopping: `speed_limit_kbps` is the cap
in KB/s, and `0` removes it. Always client-wide, never per item.

Each client speaks a different unit, and the wrong one throttles a stack to
nothing — SABnzbd reads a bare number as a *percentage* of the configured line
speed, qBittorrent wants bytes per second, Transmission wants KB/s behind an
enable flag it keeps separately. The tool boundary is KB/s and each adapter
converts at its own edge. Clearing on Transmission zeroes the number as well as
the flag, so a stale cap cannot come back the next time anything enables it.

Safe tier, because the undo is this same tool with the other `action`.

**It does not stop Radarr or Sonarr grabbing.** They carry on searching and
sending releases, which then sit in the paused client until it is resumed.
The preview says so out loud, because a bare "paused" would let someone
believe nothing is happening at all.

`service` is required, and names one client. That is deliberate rather than a
missing convenience: every write's permissions are checked against exactly
one resolved service id, so a tool that defaulted to "every configured
client" would have to nominate one of them for that check — which would mean
enabling `safe_write` on SABnzbd quietly enabled it on Transmission too.
Pausing everything is one call per client.

Already-paused is a no-op, with no token and no confirmation prompt. Only
SABnzbd publishes a client-wide paused flag; for the two torrent clients
"paused" means every torrent is stopped, and a client holding no torrents at
all reads as *not* paused — nothing to pause is a different state from
everything paused, and treating them alike would refuse a legitimate call.

The qBittorrent path is **spec-derived and unverified against a live
instance**: there is no qBittorrent on the stack these adapters were probed
against. v5 renamed `pause`/`resume` to `stop`/`start`, so both verbs are
attempted — the new one first, the old one only if it 404s.

## `discover_media`

`similar_to` takes a TMDB numeric id and answers from Seerr's
`recommendations` endpoint, not `similar` — a live check found `similar`
close to genre-bucket matching, and empty outright for series. It is
mutually exclusive with `genre`/`year`/`min_rating`: they are different
questions, so combining them is refused rather than one winning silently.
With no Seerr configured there is no fallback — the IMDb dataset has no
similarity data — and the response carries a `note` instead of a bare empty
list.

## `clean_queue`

Radarr and Sonarr leave a completed download in the queue forever when the film
or series it belongs to has been deleted: there is nothing to import it into,
so it sits at `importBlocked`. Both hide these from the queue by default, which
is why they accumulate unnoticed — `get_queue` now asks for them and marks each
one `orphaned`.

The tool removes exactly the items that are **both** `orphaned` and
`importState: "importBlocked"`, from the queue and from the download client.
That pairing is not configurable, and the reason is the first half on its own:
an item can be unlinked and still transferring, and deleting one of those
destroys a download in progress. `orphaned` describes the missing media, never
whether the item is finished with.

It never blocklists. The release was fine — the film was deleted — so any of
these can be grabbed again later.

The preview lists every item by name before anything is removed, and the
confirmation token is bound to those exact ids, so an item that appears in the
queue between preview and confirm is not swept up by a token issued before it
existed.

## `trigger_subtitle_search`

The write half of `get_subtitles`, and it takes its arguments straight from
that tool's output: `kind`, `id` and one `code2` from the item's `missing`
list. For an episode, `id` is the episode id — the series id it also needs is
resolved here rather than being one more thing to pass.

`language` is required. Bazarr searches one language at a time, and asking for
one the item is not missing is reported as nothing to do rather than sent
upstream — as is a mismatch on `forced` or `hearing_impaired`, which are part
of what makes a wanted language distinct.

It queues the search and returns. Whether a provider actually has the subtitle
is not known at that point, so call `get_subtitles` again a minute later rather
than reading success as "the subtitle is on disk". If nothing arrives, the
`providers` block in that same response is usually the reason.

### When it is not missing anything

`search_anyway: true` searches for a language Bazarr does not list as missing —
the "I have Dutch subs and they are wrong" case. The preview says plainly that
Bazarr does not consider this missing and that an existing subtitle may be
replaced.

Both refusals it lifts stay the default. An item outside the wanted list is
still refused without the flag, and a language that is not missing is still
reported as nothing to do: a write against an item the tool cannot even
describe is worse than making the caller say they meant it.

For an episode outside the wanted list, pass `series_id` too — the missing list
is otherwise the only place an episode's series id comes from, and Bazarr
rejects the call without it.

## `trigger_scan`

Three actions, one idea: make a service reconcile itself with what is on disk.

| Call | What it does |
| --- | --- |
| `service` alone | Rescans that service's whole library. On Prowlarr, which has no library, it syncs the indexer list to Radarr and Sonarr instead. |
| `service` + `id` | Rescans just that Radarr/Sonarr item — far cheaper on a large library. |
| `action: "rename"` + `id` | Renames that item's files to the service's own naming scheme. |
| `action: "import"` + `download_id` | Imports a finished download the service never picked up. |

Everything here queues a command and returns. `stack_health`'s `commands` list
says whether it has finished; do not assume it has.

### Importing a download that never landed

`diagnose` can tell you the import is the problem, and a library scan does not
fix it: the file is still sitting in the download client's folder, and the *arr
never took it. `get_queue` shows exactly this as a row stuck at
`importState: "importBlocked"`.

The flow is `get_queue` → take that row's `downloadId` → `trigger_scan` with
`action: "import"`.

The preview lists, file by file, what will be imported and what the service
refuses and why. Rejected files are **excluded** from the import rather than
forced through: this imports what the service is willing to take, and overriding
its own matching is not something it will do on your behalf.

Two outcomes that look alike and are not:

- **Nothing to import** — the service sees no files for that download id. A
  no-op, with no confirmation asked for.
- **Everything rejected** — there are files and it will take none of them. A
  refusal naming the reasons. Reporting that as "nothing to do" would read as
  "it was already imported", which is the opposite of what happened.

The import re-reads the candidates when it runs rather than trusting the
preview's list, so a download whose files have changed in between imports what
is there now or fails — never a path that no longer exists.

## `update_media`

`add_media`'s counterpart: it changes what something already in Radarr or Sonarr
is set to — `quality_profile`, `root_folder`, `monitored`, `tags`, Radarr's
`minimum_availability`, Sonarr's `series_type`.

It is also **the only way to change a Radarr item's monitoring**.
`set_monitoring` is Sonarr's per-season tool and has never covered films.

Takes `service` and `id`, never a title — `acquisition.id` on a `get_library`
or `get_media_details` record. `stack_health` at `detail: "full"` lists the
profiles, folders and tags each instance has; a name that matches more than one
is refused rather than resolved, exactly as in `add_media`.

**Changing `root_folder` moves the files on disk.** The service does the move
itself, and the preview names the source and the destination. `move_files:
false` leaves them where they are and updates only the path, which makes the
service report them missing until they are moved and rescanned — it is for
"I already moved them myself", not for avoiding the wait.

`tags` replaces the whole set rather than adding to it; `[]` clears it. An
unknown label is refused, listing the ones that exist — nothing here creates a
tag.

Safe tier. Every field is one the same tool sets back, and a move loses
nothing: the undo is moving it back. A request that would change nothing is a
no-op, and a request naming no field at all is refused rather than previewed.

## Prompts and resources

Thirty-four tools do not tell you which one to reach for, and the questions
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
