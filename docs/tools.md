# Tools

Forty of them. The first nineteen read; the last twenty-one write, and are
off until you turn them on — see [writes](writes.md).

| Tool | Answers |
| --- | --- |
| `diagnose` | Why is this not playable? |
| `stack_health` | Is anything broken, out of disk, or not scanning? |
| `search_media` | What do I have, what exists, what can I get? Books in Grimmory too, from the library |
| `get_media_details` | Everything about one item; on Lidarr, one artist and the albums under it; on Grimmory, one book and its files |
| `get_metadata_issues` | Which films and series have metadata that does not describe their files; which Grimmory books have a low match score or no identifier |
| `get_library` | What's in my library — joined across Radarr, Sonarr, Lidarr and your media server, and where they disagree; Lidarr artists are their own kind, joined by MusicBrainz id; Grimmory books are their own kind too |
| `get_profile_issues` | Which quality profiles and custom formats are misconfigured, and where Profilarr has drifted from Radarr/Sonarr |
| `get_queue` | What is downloading, across the *arr queues and every download client, and what waits in Grimmory's Bookdrop |
| `get_history` | Why did last night's download fail: grabbed, imported, failed, deleted, and what SABnzbd, NZBGet, Bazarr, Cleanuparr, Reclaimerr and Shelfmark did; on Grimmory, deleted books, metadata changes and scans |
| `get_wanted` | Which episodes of a show are missing, and what has a file below cutoff |
| `get_releases` | What an interactive search actually found, rejects included; on Shelfmark, the files on offer for a book |
| `get_blocklist` | Why does it keep finding the same release and never downloading it |
| `get_calendar` | What is due, and what just aired |
| `get_subtitles` | What is missing subtitles, and which providers are throttled |
| `get_playback` | What am I watching, and what can I continue |
| `get_indexers` | Which indexers are healthy, and what they recently rejected |
| `get_requests` | What has been requested, and what is still pending |
| `lookup_media` | Tell me about this, without adding it; artists too, with Lidarr, and books, with Shelfmark |
| `discover_media` | What exists in this genre, year, or rating band |
| `trigger_search` | Go look for this again — the whole thing, one season, or specific episodes; on Lidarr, an artist or some of its albums |
| `trigger_scan` | Refresh and rescan a library or one item, rename one item, import a download that never landed, put a mislabeled Sonarr file on the right episode, rerun NZBGet's post-processing, or rescan a Grimmory library or its Bookdrop |
| `trigger_subtitle_search` | Go and find the subtitles this is missing, now |
| `grab_release` | Not that one — grab this release from `get_releases` instead; on Shelfmark, the most-downloaded file unless you name one |
| `set_monitoring` | Turn monitoring on or off: a whole series (by id or title), one season, specific episodes; on Lidarr, `level: "album"` for one album or `level: "artist"` with `artists` and `monitor_new_items` for a policy over the set |
| `retry_download` | Try this failed usenet download again, with its password if it needs one, or a failed or cancelled Shelfmark book |
| `pause_downloads` | Pause, resume or throttle a download client, or one item in its queue |
| `remove_queue_item` | Get rid of this stuck or wrong download; on Grimmory, discard a file waiting in the Bookdrop |
| `remove_blocklist_item` | Let this blocklisted release be grabbed again |
| `clean_queue` | Clear out completed downloads whose film, series or artist no longer exists |
| `delete_media` | Remove this film or series, optionally from disk; on Grimmory, delete a book and its files |
| `delete_episode_files` | Free disk from one season or a handful of episodes, without touching the series |
| `respond_to_request` | Approve or decline what someone asked for |
| `delete_request` | Drop a request record entirely |
| `request_media` | Ask Seerr for this, through its approval queue and quotas |
| `add_media` | Add this film or series and start looking for it; on Lidarr, an artist |
| `update_media` | Change the profile, folder, monitoring or tags of something already there, and a Lidarr artist's metadata profile; on Grimmory, a book's title, authors, series and categories |
| `fix_metadata` | Repair one item whose metadata does not describe its files; on Grimmory, a book, from its metadata providers |
| `set_watched` | Mark this watched or unwatched in Jellyfin; on Grimmory, mark a book read or unread |
| `sync_database` | Have Profilarr pull its database from git again |
| `manage_indexer` | Add a public indexer, change its priority, profile, tags or seeding, stop grabbing from it, or delete it |

The rest of this page is the shape of the answers: the fields whose meaning is
not obvious, and the places where a value is deliberately absent rather than
`false`.

**Whisparr** is a Sonarr fork and answers wherever Sonarr does below, with one
difference: a site has no seasons, so **a season is a release year**, `2019`
rather than `1`. A year the site does not have is refused, and the refusal
lists the years it does. It does not answer `get_history`, `get_wanted`,
`update_media` or `fix_metadata`, nor `trigger_scan`'s `import` and `remap`
actions, and its commands do not appear in `stack_health`'s `commands` list. `add_media` works as it does on Sonarr,
by TVDB id — Whisparr reuses that field for its own scene-database id, not
TheTVDB — except `series_type`, which is Sonarr only, and `monitor: "pilot"`,
which a site has no equivalent of. Only Whisparr V2 is supported;
`stack_health` reports a V3 (Eros) instance as an unsupported version.

## Every tool answers the same way

Every read tool but `diagnose` takes `detail` (`minimal`/`standard`/`full`) and
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
which list it meant to skip into — and neither is one you page through. The
Reclaimerr candidates under `cleanup`, at `detail: "full"`, take their own
`limit` rather than sharing that budget.

Both halves of that contract are enforced against the services themselves, not
only in this server: `get_queue` asks Radarr and Sonarr for the whole queue
rather than accepting their ten-row default, and `get_requests` and
`get_indexers` push a status filter upstream where the service supports one, so
a filtered answer is not a filtered slice of an arbitrary window.

Tools spanning several services also report which ones they could not reach, so
a long answer from one service can never silently hide another being down. Most
of them carry `counts` as well, saying how many results each contributed;
`get_indexers` and `get_subtitles` do not, and every row there names its own
service instead.

Two of those tools carry a second kind of gap. `get_indexers` reads rejection
history alongside the indexers themselves, and `get_subtitles` reads provider
state alongside the gaps; either can fail while the main read succeeds. That is
**not** `degraded` — the instance did answer — so it is reported separately as
`rejectionsUnavailable` and `providersUnavailable`, naming the instances whose
half is missing. Without it, one of two Prowlarrs failing leaves a rejection
list that is present, plausible and missing half the stack.

`get_indexers` does the same across instances of one service: it merges every
configured Prowlarr, each row naming the instance it came from, and one
unreachable instance degrades by name rather than emptying the answer.

`diagnose` takes a title, or an exact `service` plus `id`, and returns a verdict
rather than a list. With several instances of a service configured it also takes
`instance`, worded exactly as the write tools word it.

**Every answer comes twice: a summary and a structure.** The text block is for
a reader; `structuredContent` is the contract, and every tool declares its
shape as an `outputSchema` so a client knows what it will get before it calls.
Read `total` from there rather than parsing it out of "50 of 243 item(s)" —
that sentence is prose and may be reworded.

A list tool's text block is the count sentence *and then one line per item*,
naming each item and the id a follow-up call takes:

```
2 of 1885 item(s).
<<untrusted:radarr.title>>Inception<</>> (2010) — movie, radarr:412, tmdb:27205
<<untrusted:sonarr.title>>Severance<</>> (2022) — series, sonarr:31, tvdb:371980
```

It was the count alone until 1.26. Not every client forwards
`structuredContent`, and on those the items were unreachable — a call that
worked, answering "what is in my library" with a number and nothing to name
(#234). The lines are bounded by `limit`, exactly as the structured half is,
and titles keep their untrusted-data fence: the text block is the half that
goes straight to a model, which is where that marker matters most.

**The tool list is cacheable for an hour.** On the 2026-07-28 protocol
revision every list result carries a `ttlMs`, and `tools/list`,
`prompts/list` and `resources/list` say an hour. They can, because the lists
are static by construction: every tool, prompt and resource is registered
unconditionally, so nothing a configuration edit does can change what is in
them. A client that honours the hint stops reloading the whole surface every
session. The four resources are different, each carries its own hint, and
`arr://health`'s is deliberately zero, because a pinned health snapshot
saying a dead service is fine is worse than no snapshot at all. Clients on the
2025 protocol see none of this and are unaffected.

**A client can tell the reads from the writes without reading prose.** Every
tool carries a title and an annotation: `readOnlyHint` on the nineteen that only
read, and on the twenty-one writes `destructiveHint`, taken from the same permission
tier the write gate itself runs on — so a tool cannot be gated as destructive
and advertised as safe. A client deciding what to auto-approve, or what to warn
about, reads those rather than guessing from forty similarly-shaped
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

## `get_history` and the event log

`delete_media` removes a title's history from Radarr or Sonarr along with the
title. With `source: "webhooks"`, `get_history` reads the events those services
reported to arr-mcp instead, so this is the only record that survives a delete.
It needs the [library event log](configuration.md#the-library-event-log) turned
on, and it holds nothing from before that.

`service`, `instance`, `id`, `event_type`, `since` and paging work as they do
for the default `source: "services"`, which never includes stored rows. A service
other than Radarr or Sonarr is refused. `note` says when the log is off or when
nothing has arrived, and an unreadable store is `event-log` in `degraded`.

A stored row differs from a service's own row in a few ways:

- `at` is when arr-mcp received the event, because the payload has no timestamp.
- `id` is arr-mcp's own row number.
- `externalIds` holds TMDB, TVDB and IMDb ids. A re-added title gets a new
  `mediaId`, and these stay the same.
- `added` is a new `event`, and events without a captured payload are `unknown`
  with their name in `rawEvent`, at every detail level.
- `reason` is why a file went (`manual`), or for a deleted title whether its files
  went too (`files deleted`, `files kept`).

The Logs page shows the same rows under **Library events**.

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

With two media servers the verdicts are against the primary. The library step
adds "Also in" or "Not in" the other server's library, as extra detail and
never as a blocking stage. A secondary that is down does not lower `certain`.

**It also works with services down.** Any step it could not check sets
`certain: false`, and the summary names what was missed: a confident verdict
across a hole is worse than no verdict. When the title is found (in the media
server, say) but no *arr claims it, and a Radarr, Sonarr, Whisparr or Lidarr
that holds its kind could not be read, `managed` is `unknown` rather than
"nothing is managing it": the verdict is `managed`, uncertain, and asks you to
check that service and diagnose again, unless a blocked request comes first.
A Jellyfin id gives no kind, nor does a Plex item that is not a film or a show,
so there any *arr that could not be read counts.

When Cleanuparr removed or stopped the download and nothing is in the queue,
the queue stage says so, with the date, its reason and its strike count, and
`remedy` points at its rules. This only applies while the item has no file; a
file on disk means the removal was since replaced. A dry run is shown as "would
have removed or stopped it" and does not block the verdict. While a download
client cannot be reached, the queue stage is unknown instead, since a new grab
could be on that client. A download still in the queue that Cleanuparr has
struck carries its strike count and kind in the queue stage, unless a later
reset cleared them. A torrent still seeding a file that is already in the
library is `ok`, or `warning` when it has strikes, including qBittorrent's
`seeding (no peers)`; `warning` never blocks the verdict.

When a query matches nothing in the library, `diagnose` searches download
history by release name before answering "Nothing in your stack matches". This
covers a film removed from Radarr whose torrent Cleanuparr then cleaned: no
library has it, but Cleanuparr's events do. It reads Cleanuparr's events (the
last 30 days, at most 500) and the own history of each download client that
keeps one, which today is SABnzbd and NZBGet; a torrent client keeps nothing
once a torrent is removed. A release matches when the query's title words lead
its name, ignoring case, dots, underscores and a leading article. A year or
episode in the query (`Shogun 2024 S01E03`) must not be contradicted by the
release, and a season pack matches any episode of its season. The verdict stays
at `resolve`, and the summary says what happened to up to three matching
releases, for example "Cleanuparr removed … on 2026-10-27: MaxSeedTimeReached,
after 3 strikes." `history` holds the row behind each one. Nothing matching
leaves today's answer, and a history source that could not be read sets
`certain: false`. A query that resolves never triggers this read.

With the [library event log](configuration.md#the-library-event-log) on, that
search covers its last 30 days too, which is how `diagnose` can explain a title
deleted from Radarr or Sonarr, since deleting it removes its history from the
service. The summary says, for example, "radarr reported deleting … on
2026-11-05: files deleted." It doesn't say who deleted it, because the payload
doesn't. The store can't be read: `event-log` in `degraded` and `certain: false`.

With Reclaimerr configured, `diagnose` looks the title up there by its TMDB id.
When the managing *arr has no file and Reclaimerr deleted or moved the whole
title in the last year, the file stage says so, with the date and the rule, and
`remedy` says to protect it in Reclaimerr before searching again, since the same
rule would otherwise delete it again. A removal of one season or episode leaves
the rest on disk, so it is only mentioned in the summary. When a rule has the
title scheduled for deletion, or eligible at the next deletion run, the summary
says so with the date and the rule. Neither blocks a playable verdict, and a
Reclaimerr that cannot be read only adds it to `degraded`.

With Bazarr configured, `diagnose` ends with a `subtitles` step for a title that
has a file. It lists the languages Bazarr is missing for it and is `warning`, not
`blocked`: the verdict stays where the other stages put it, a playable title is
still `playable`, and `certain` does not depend on it. The summary of a playable
title carries the sentence. A gap matches by id and by title, because nothing
says which Radarr or Sonarr a Bazarr is paired with, and a series matches by
series id. The step is `unknown` when Bazarr cannot be read, and `skipped` when
there is no file or no Bazarr. Bazarr's wanted list is read whole, with no
paging, so it is the one read that grows with the size of the library, and it
adds Bazarr to `degraded` when it fails. Only the first Bazarr is read, as with
Cleanuparr. An item with no id to match gaps by is `unknown`, not `ok`.

**Books.** A book never passes through the chain, so `diagnose` refuses one,
including `service: "grimmory"`, before reading anything. The refusal points to
`get_media_details` for the book and `stack_health` for Grimmory itself. A book
with the same name as a film is skipped when a title is resolved, and a Grimmory
outage does not lower `certain`.

**Lidarr artists.** `diagnose` walks an artist as it does a film: by name, or with
`service: "lidarr"` and the artist id. A film or series of the same name wins over
the artist only when it matches the name as well as the artist does: an artist named exactly
as asked beats a film that merely starts with or contains the name. The chain is the same, with these differences:

- `request` is `skipped`, saying Seerr does not handle music, and Seerr is never
  read for an artist. Neither are Bazarr (`subtitles` is `skipped`, since it has
  no music) nor Reclaimerr, so an outage of any of them costs an artist nothing.
  Cleanuparr is still read when the artist has downloads to match, because it
  explains what happened to a download.
- `queue` reads Lidarr's queue and the download clients', and not Radarr's or
  Sonarr's. A film is read the other way round, so a Lidarr that is down leaves a
  film's verdict as certain as before and makes an artist's `queue` `unknown`.
  Rows are tied to the artist by `mediaId` first. A download client's row counts
  only through a Lidarr row sharing its download id, so a film's release that
  merely shares the artist's name is not blamed on the artist; an orphaned Lidarr
  row is still matched by its release name.
- `file` means any track on disk, as `has_file` does for a series. A missing one
  suggests `trigger_search` on the artist. Lidarr grabs only releases of a
  monitored album, so the albums are read first: with none monitored, the step
  is `set_monitoring` on its only album, or `get_media_details` to choose from
  several, and with no albums at all it is `trigger_scan` to refresh the artist.
  A failed album read is `lidarr:albums` under `degraded` and leaves the search
  step in place.
- `library` follows the music read, not the film read. It is `unknown` when that
  read failed. When the read worked and the server lacks the artist (including a
  server with no music library, or an artist with no MusicBrainz id on the
  server) an artist with tracks on disk is `blocked`: the server cannot see it.
- An artist with a track on disk and everything else clear is `playable`, and the
  summary says that only means at least one track is there: `get_media_details`
  lists the albums and which of them have files.

This has been tested against the recorded Lidarr responses and stand-ins, not
against a running Lidarr.

**Next steps.** Beside the prose `remedy`, `verdict.next_steps` holds the tool
call that does it, as `{ tool, arguments, why }`, and the text block ends with
the same call as a `Next:` line. The server never runs it: a client offers it to
the person, and a write still previews and asks for confirmation. A step names
an instance as `service` plus `instance` (`radarr/hd` is `service: "radarr"`,
`instance: "hd"`). The text a step carries is never a service's: `arguments`
hold ids, `download_id`, and, for a lookup, the words you gave as `query`.

| Verdict | `next_steps` |
|---|---|
| `file`, no cleanup removal | `trigger_search` with the managing service and id; for an artist with no monitored album, `set_monitoring` on its only album or `get_media_details` to choose one, and with no albums `trigger_scan` with its id |
| `file`, removed by a cleanup rule | none: protect the title in Reclaimerr |
| `managed`, not monitored and removed by a cleanup rule | none: monitoring would search for it again. Protect the title in Reclaimerr first; the summary names the removal |
| `managed`, in Radarr | `update_media` with `monitored: true` (`set_monitoring` refuses Radarr) |
| `managed`, in Sonarr or Whisparr | `set_monitoring` with `monitored: true` |
| `managed`, in Lidarr | `set_monitoring` with `level: "artist"`, `artists: [id]` and `monitored: true`, never `id`: the artist flag only, each album keeps its own |
| `managed` or `resolve`, nothing manages it | `lookup_media` with your `query`, only when you diagnosed by title, and for `managed` not while an *arr of its kind (any *arr, for a media server's id with no kind) could not be read; an artist comes back among Lidarr's hits, each with the MusicBrainz id `add_media` takes as `ids.mbid` |
| `request`, pending | `respond_to_request` with `verdict: "approve"`, only if you may act on that request (it is yours, or `allow_other_users` is on) |
| `queue`, import pending | `trigger_scan` with `action: "import"` and the `download_id` of the *arr's row, on Radarr, Sonarr or Lidarr |
| `queue`, fault | `remove_queue_item` with the row's service and id; it deletes partial data and does not blocklist |
| `queue`, a stopped or paused download, or a fault whose import is pending on another row of the same grab | the import above, never the removal |
| `library` | `trigger_scan` with `action: "scan"` on the media server |
| playable, one film or episode missing a subtitle | `trigger_subtitle_search` with the first missing language, only when Bazarr gave it a code |
| `scan`, `indexers`, playable otherwise, still downloading | none |

A step is left out when its tool would refuse it or when it cannot be built:
no id to search for, a Whisparr download (which has no manual import), or an
approval for someone else's request without `allow_other_users`. A step is still
offered when the server's own settings would make the write refuse (`safe_write`
off, or a read-tier token): the write then refuses and says how to fix it. The `remedy`
and verdict still say what is wrong. A search offered while Reclaimerr could not
be read says so in its `why`.

An applied `trigger_scan` with `action: "remap"` returns the same field when a
media server that can scan is configured: a `trigger_scan` of it, in place of
the sentence telling you to rescan by hand. Any write can carry `next_steps`; a
step that fails to build never fails a write that already landed.

## `stack_health`

With more than one instance of a service, each is reported separately. With
Plex and Jellyfin both configured, `primaryMediaServer` names the one the tools
default to.

It also reports `endpoints` — `instance`, `service` and `baseUrl` for every
configured instance, so a script knows where each one lives. It never carries a
key: **no tool in this server returns an API key**, because anything a tool
returns passes through a model's context. A script that needs credentials runs
beside `config.yaml` and imports `loadConfig`.

`endpoints` is absent at `detail: "minimal"`, alongside `permissions` — a URL is
no more a fault than a grant is.

### Which services report health checks

`failures` carries what each service says is wrong with itself. Radarr,
Sonarr, Whisparr, Lidarr, Prowlarr and Bazarr report their own health checks,
NZBGet its `systemhealth` alerts (v26 and later), and Cleanuparr, Reclaimerr,
Dispatcharr and Shelfmark their own status (see [Dispatcharr](#dispatcharr) and
[Shelfmark](#shelfmark) below). Grimmory reports unreachable libraries, old
Bookdrop files and a newer release (see [Grimmory](#grimmory) below).

SABnzbd reports the warnings and errors from its log, and only those from the
last 24 hours. Its warnings list is a log rather than a state: it keeps every
row until a restart or until someone clears it, so a provider that refused
connections a week ago would otherwise still read as failing. Rows from the
same source are collapsed into one, with the newest text and a count of the
rest, because one flaky provider can log dozens of near-identical lines. The
text is in SABnzbd's own UI language.

qBittorrent, Transmission, Plex, Jellyfin, Seerr and Profilarr have no health
report this server reads. They appear in `services` with their version and
connection state, and a fault in one of them shows up as a failed connection
in `degraded` rather than in `failures`.

### What each instance will accept, at `detail: "full"`

`options` lists, per Radarr, Sonarr, Whisparr or Lidarr instance, the
`qualityProfiles`, `rootFolders` and `tags` it actually has. Lidarr's metadata
profiles are not listed here: `add_media` and `update_media` name them when one
must be chosen. These are the values `add_media` and `update_media` refuse to
guess at: with more than one profile they insist you name which, and this is
where the names come from. Only at `full`, because it is three extra calls per
instance and it answers "what may I choose", not "is anything broken". An
instance whose profile list cannot be read is named in `degraded` and left out
of `options` — the rest of the answer stands.

Each root folder also carries `unmappedFolders` when the instance reports any:
the folder names under that root it associates with no item. It rides along on
a call already being made, and it is the only trace the API gives of a mapping
the service has lost — an item whose files it no longer knows about is never
renamed, upgraded or searched for again. Read it as a fact rather than a
verdict: a folder dropped in by hand and a delete that kept its files look
exactly the same from here. Absent rather than empty when the root is fully
mapped, so "nothing unmapped" stays distinguishable from "the service did not
say".

### Seeding rules, at `detail: "full"`

`seedingRules` answers "what are my seeding rules". `clients` gives each
torrent client's default `ratioLimit` and `seedingLimitSeconds` (absent means
none) and the `action` it takes on reaching one. `indexers` gives each torrent
indexer's `seedRatio` and `seedTimeSeconds` from Radarr, Sonarr, Whisparr and
Prowlarr, plus Prowlarr's `privacy`. An *arr hands its indexer's criteria to the
client with every grab, and they override the client default, so the indexer
row is usually the one that decides.

`notes` names two gaps. One is an app's copy of an indexer that disagrees with
Prowlarr's, matched on the `"<name> (Prowlarr)"` name sync gives it. The copy is
what the app applies. The other is a torrent indexer with no criteria while no
client has a default either, meaning its grabs seed until someone stops them.
When an enforced Cleanuparr rule set limits seeding on one of the clients, those
indexers get one note instead, saying Cleanuparr's rules are the only limit and
that a torrent in a category no rule covers still seeds on. Which torrents are actually past their limit is `get_queue`'s answer, not this
one. Absent when nothing configured seeds.

### Cleanuparr

With Cleanuparr configured, its health findings join the failing checks: an
unhealthy entry, a disconnected *arr or download client, a Queue Cleaner that
is not scheduled, dry run being on, and a Cleanuparr minor newer than 2.10
(flagged as untested). A source it could not read is a warning of its own, and
the rest still report.

At `full`, `seedingRules.cleanuparr` lists the rule sets of each Cleanuparr
download client. A set carries `service` when it maps to an arr-mcp torrent
client, matched on client type and `host:port`. A set that matches none, or that
shares a client with another set, has no `service` and `notes` says why.
`notes` also says when a rule's ratio differs from the client's own, and when
the Download Cleaner is not scheduled, which means none of the rules run.

`seedingRules.coverage` checks the rules against the torrents. For each
torrent client a rule set maps to, it reads the client's torrents (one call,
the same read as `get_queue`) and gives `torrents`, `uncovered` (no rule
matches, so the Download Cleaner never removes them) and `ignored` (on
Cleanuparr's ignore list, so not counted as uncovered). Counts only, never a
torrent list. When some are uncovered, `notes` breaks the count down by why:
no category, a category no rule names (the five biggest, with counts), a
tracker, tag or public/private filter. A torrent the client reports no working
tracker or no private flag for is counted, and the note says a rule may still
cover it. On Transmission the category is the last folder of the download dir,
as Cleanuparr reads it.

`notes` also names:

- rule categories no torrent on the client is in, which is usually a typo or a
  category renamed in the client. Categories come from the torrents, so one the
  client defines but nothing uses counts as absent. The categories Unlinked and
  Dead move torrents into are left out, since those are often empty.
- a Cleanuparr client with no seeding rules, and whether Unlinked, Dead and
  Orphaned are all off too, in which case the Download Cleaner does nothing
  with it.
- a configured torrent client that no enabled Cleanuparr client matches on type
  and `host:port`. Deleting a client in Cleanuparr drops its rules and its
  Unlinked, Dead and Orphaned settings, so this is what that looks like
  afterwards. It also fires when Cleanuparr reaches the client under a different
  host than arr-mcp does.

A client whose torrents could not be read gets no `coverage` row and joins
`degraded`. Which rule covers a particular torrent is `get_queue`'s answer at
`detail: "full"`.

Each set also carries the Download Cleaner's three per-client modules, when
Cleanuparr reports them. A module that is off is just `{ "enabled": false }`.

- `unlinked`: torrents in `categories` whose files have no hardlinks are moved
  to `target`, a category, or a tag when `useTag` is set. `ignoredRootDirs` is
  where hardlinks are not counted.
- `deadTorrents`: torrents in `categories` that report no seeders on
  `maxStrikes` runs in a row are moved to `target`, the same way.
- `orphanedFiles`: each entry directly inside a `scanDirectories` entry that no
  torrent claims, whose name matches no `excludePatterns` glob, and that is older
  than `minFileAgeHours`, is moved into `orphanedDirectory`. That directory is
  emptied of anything older than `purgeAfterHours`. Absent `purgeAfterHours`
  means it is never emptied.

Paths are fenced. Categories and patterns are not, the same as rule categories.

`notes` adds the following for these modules:

- an Unlinked or Dead Torrents `target` category that none of that client's
  seeding rules covers, so whatever is moved there keeps seeding. A module that
  tags instead is left out, because the torrent keeps the category its rule
  already covers.
- an orphaned directory that is never purged. arr-mcp cannot see how big it
  is, only that nothing empties it.
- for a set mapped to an arr-mcp client, that client's save directories, read
  from its torrents, compared with the scan. Cleanuparr looks only one level
  down, and a torrent claims its save directory and its own top-level entry.
  So a save directory that is not a scan directory is never searched. A folder
  between a scan directory and a save directory counts as one unclaimed entry,
  and Cleanuparr would move it whole, torrents included, unless its name is
  excluded. That is why cross-seed link directories are listed one per
  tracker. Paths are compared as Cleanuparr compares them: either slash, no
  trailing slash, ignoring case. Cleanuparr can map a client's paths onto its
  own mount, but that mapping is stored in its download client settings next
  to the password, and arr-mcp never reads those. So when none of the save
  directories lies inside any scan directory, the note says the two cannot be
  compared and stops there, without flagging each directory.

The client's torrents are read once and serve both this and the rule coverage above.

#### Why did my download disappear?

Also at `full`, `cleanuparrRemovals` says when the Queue Cleaner and the
Malware Blocker take a download away, and what that does. It is read-only, like
everything else this server asks Cleanuparr.

`queueCleaner` has `enabled`, `scheduled` (from Cleanuparr's job list),
`schedule` (the cron expression) and one `strikes` row per limit that is on:

| `strike` | Counted when | Notes |
| --- | --- | --- |
| `FailedImport` | the *arr reports an import it cannot finish | `patterns` gives the mode and how many patterns there are, not the patterns. `forceImport` means Cleanuparr tries the import first. |
| `DownloadingMetadata` | qBittorrent is still fetching metadata | qBittorrent only. |
| `Errored` | the torrent client reports the download as errored | Cleanuparr asks the client to resume it on every strike. Cleanuparr 2.10.11 and later. |
| `Stalled` | one row per enabled stall rule, `rule` is its name | |
| `Slow` | one row per enabled slow rule, with `minSpeed` and `maxTimeHours` | |

Each row has `maxStrikes`, `atLimit` (`remove` takes it out of the *arr queue,
`change_category` leaves it in the client under another category), `appliesTo`
(`public`, `private` or `both`) and, when private torrents are judged,
`privateTorrents`: `kept_in_client` or `deleted_from_client`. A metadata stall
always deletes from the client, whatever the privacy, because Cleanuparr's
qBittorrent check asks for it. `completion` shows a rule's completion range when
it is narrower than 0–100%.

`onRemoval` says what every removal does. The *arr always blocklists the
release, and `searchesAgain` says whether Seeker search is on, which decides if
a new search is queued. Even with search on, Cleanuparr skips the search for a
download the *arr cannot tie to a film or episode, and for one that keeps
coming back after it passed its limit. `ignoredCount` counts the Queue Cleaner's own ignore list, not
the general one.

`malwareBlocker` lists the `blocklists` turned on per *arr: `type` is
`blacklist` or `whitelist`, and `source` is the host of a URL list or `file`
for a local one. The rest of the URL is dropped in case it carries a token.
Blocked files are skipped in the client. `removesWhen` says whether the whole
download goes when `all_files_blocked` or as soon as `any_file_blocked`.
`privateTorrents` is `skipped`, `kept_in_client` or `deleted_from_client`.

`notes` flags a setting that deletes a private torrent and its files from the
client, which ends its seeding. On a private tracker that can count as a
hit-and-run. It also names a cleaner whose settings could not be read; when
neither can, Cleanuparr is named in `degraded` instead.

One thing it cannot see: each *arr can override the failed-import strike count
in Cleanuparr, including turning failed imports on when the global count is 0,
and that setting is served together with the *arr's API key, so it is not read.

### Reclaimerr

With Reclaimerr configured, its health findings join the failing checks: a
status other than `ok`, no main media server (rules based on watch history
cannot match), a candidate whose deletion failed (with the attempt count and
Reclaimerr's error), an API token missing one of the read scopes arr-mcp uses or
carrying a write scope it does not need, and a Reclaimerr minor newer than 0.6
(flagged as untested).

At `full`, `cleanup` says what its rules will do: `candidates`, soonest first
(`eligible` goes at the next run of the deletion task, then `scheduled` by
`eligibleAt`, then `postponed`, `disabled` and `canceled`), each with its
scope, the rules that matched it, `operation` (`delete` or `move`), `blockers`
and any failed deletion. `rules` lists every rule with its outcome
(`candidate`, `protect` or `match`), `protections` counts the active
protections, `totals` gives the reclaimable and reclaimed bytes, and
`autoDelete.enabled` says whether the deletion task runs at all: when it is
off, nothing is deleted on its own whatever the dates say. The candidate list
takes the call's `limit`; `total` is always the full count. `going` counts the
`eligible` and `scheduled` ones over every candidate, not only the ones
returned, with `firstAt` the soonest date; the summary line quotes it.

### Dispatcharr

With Dispatcharr configured, its findings cover the live TV that Plex and
Jellyfin play from it:

| Finding | Level |
|---|---|
| An M3U account failed to refresh | error |
| An M3U account is still pending setup | warning |
| An M3U account has not refreshed in three of its refresh intervals (skipped on a cron schedule or an interval of 0) | warning |
| A provider account's expiry date has passed | error |
| A provider account expires within 14 days | warning |
| An EPG source failed to refresh | error |
| Dispatcharr is newer than 0.33.x, the minor this adapter was written against | warning |

Accounts, profiles and sources switched off in Dispatcharr are ignored, and so
is the locked built-in `custom` account every install has: it has no URL or
file, so each of its refreshes fails, and Dispatcharr hides it and will not let
it be changed.

A failed refresh says why in a fixed set of words, such as "no playlist URL or
file is set", "the provider refused the login (HTTP 884)", "the guide file was
incomplete or malformed" or "the request timed out", and "refresh failed" when
the cause is not one it knows. Dispatcharr's own error text is never quoted:
it carries the provider URL, and with it the subscription's username and
password, along with whatever the provider sent back.

Dispatcharr is read, never written: there is no tool for its channels or
playlists, and its findings appear only here.

### Shelfmark

With Shelfmark configured, its findings cover book downloads:

| Finding | Level |
|---|---|
| The download coordinator is stopped, so nothing downloads | error |
| Downloads failed in the last 7 days, with the count | warning |

`get_queue` lists books waiting, downloading or failed, as `<title> by <author>`,
with Shelfmark's own reason on a failed one. Finished and cancelled books are left
out. A read-only key cannot see the queue, so `get_queue` reports Shelfmark as
degraded with that key rather than claiming the queue is empty.

To get a book, `lookup_media` finds it (`kind: book`) and `grab_release` with
`service: shelfmark` and that id queues the most-downloaded file, with `safe_write`
on. The preview names the file first. To choose another, `get_releases` lists what
is on offer, most-downloaded first, with rows from sources that count nothing last,
and `grab_release` takes a row's `guid` and `indexer_id`. Shelfmark has no indexer
ids, so `indexer_id` is always 0. Listing searches every source
Shelfmark has and took 24s to 54s on a live server, so a listing is reused for five
minutes. Ebooks only.

`remove_queue_item` cancels a queued or running book, with `destructive` on. It
refuses a failed one, which has nothing left to cancel, and
`remove_from_client: false`, because Shelfmark has only the one way to cancel.

`get_history` shows finished, failed and cancelled books as `imported`, `failed`
and `stopped`, with Shelfmark's reason on a failure. It reads the latest 200 books
in Shelfmark's activity list and up to 500 dismissed from it. `at` is when a
dismissed book ended; on the others it is when the book was queued, the only time
Shelfmark gives for them, so a `since` filter works from that. `retry_download`
takes the `id` of a failed or cancelled row, with `safe_write` on, and refuses a
row Shelfmark marks as not retryable. Shelfmark's history has no per-book scope, so
`id` is refused on `get_history`.

`diagnose` leaves Shelfmark out, because a book is not on the film and series
chain it walks.

### Grimmory

With Grimmory configured, its findings cover the library and the Bookdrop:

| Finding | Level |
|---|---|
| A library whose folder cannot be reached, by name | error |
| Books left in the Bookdrop for more than a day, with the count and the date of the oldest | warning |
| A newer Grimmory release than the one running | notice |
| A read it could not do: libraries, library health, version or Bookdrop | notice |

The notice for a read names which one failed and, for a 403, says "this account
may not read" it, so a user without `canAccessBookdrop` loses the Bookdrop
finding and nothing else. The update notice only appears when the latest release
is newer than the running one.

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

Radarr, Sonarr, Lidarr and Prowlarr are read. Whisparr is not, because its
command list has no captured fixture yet, so nothing can be concluded from a
Whisparr command being absent.

**A command that is not in the list has finished.** The fifteen-minute window
is what makes that readable rather than merely true: a search you started a
minute ago is still there with its outcome. Older than that is history, which
`get_history` answers. Absent at `detail: "minimal"` — a running command is
not a fault — and bounded like `scans` rather than sharing the `limit` budget.

### Why is it failing?

At `detail: "full"`, `logs` lists the recent warnings and errors each Radarr,
Sonarr, Prowlarr, Seerr and Bazarr wrote to its own log, newest first. A health
check says *what* is broken ("download client unavailable"); the log line says
*why* ("Name does not resolve (qbittorrent:8080)", a path it cannot write).

The last 50 warning-or-worse lines are read per instance, and lines that differ
only in a date-time are folded into one row: `level`, `logger`, `message`,
`exceptionType`, `count`, `firstSeen` and `lastSeen`. `message` is the newest line
as written. A client test that fails every two seconds writes the same pair of
lines dozens of times, and an RSS warning quoting the period it missed differs
only in its times; on the recorded fixture, 20 lines fold into 3. Hosts, ports,
IP addresses and other numbers stay in the comparison, so `server1:8080` and
`server2:8080` stay apart. `logs` is an envelope with its own `limit` budget. A
log that cannot be read marks the instance `degraded`.

Those lines are not the whole log. `logs.lines` gives each instance's `read` and
`total`; `count` and `firstSeen` stop at what was read, and a retry storm can push
the line that explains it out of the window. There is no time limit either, so an
old line may no longer apply: `lastSeen` says how old it is.

The services differ in a few ways. Seerr's `errorMessage` is appended to `message`,
because that is where it says why, and the rest of what a Seerr line was logged
with is dropped. Bazarr has no logger name, so `logger` is `bazarr`; its times are
local with no offset, so its rows sort as if in this server's time zone. It answers
with its whole current log, so its `total` counts the warnings and worse in that.
A value that looks like an API key, token or password, an `Authorization` header's
value and any credentials inside a URL are replaced with `(removed)` in every
service's lines. SABnzbd's warnings are in `failures` rather than here.
Jellyfin's real log is plain-text files, and Dispatcharr and Profilarr have no log
to read, so none of the three appears here.

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
`set_watched` takes. With Plex as primary that id is Plex's, so take it from
`media_servers.jellyfin.itemId` instead, as
[below](#which-media-server-has-it).

**An artist's `acquisition.id` is Lidarr's artist id**, which `set_monitoring`
takes with `level: "artist"`. An album id is not on a library row at all: take it
from `get_media_details` on the artist, and pass it with `level: "album"`.
`trigger_search`, `get_releases` and `grab_release` take the artist id as `id`,
with album ids in `albums` or `album` to narrow the search, and `update_media`
takes it as `id` to change the artist's profiles, folder, monitoring or tags.

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

`quality` is for films and books. A series has no series-level quality. On a
book it is the file format, such as `EPUB`.

Rating filters are mostly films only too, because Sonarr carries one flat TVDB
rating rather than per-source scores. The exception is `imdb`, which the
[IMDb dataset](imdb.md) supplies for series as well — **and only it does**, so
asking for a series' IMDb rating with the dataset off finds nothing.

Asking for a combination that cannot exist returns a refusal explaining why, not
an empty list. Asking for one that needs the dataset says so in
`ratingCoverage.note` rather than reporting a bare zero.

### Music, from Lidarr

Lidarr adds a third `kind`, `artist`, and it joins to a media server on the
MusicBrainz artist id — the one id both Jellyfin and Plex publish for an artist.

| Field | Meaning for an artist |
| --- | --- |
| `title` | The artist name, fenced like every other service string |
| `ids.mbid` | The artist's MusicBrainz id: Lidarr's `foreignArtistId`, Jellyfin's `ProviderIds.MusicBrainzArtist`, Plex's `mbid://` guid. Matched case-insensitively |
| `albumCount` | How many albums Lidarr holds for the artist. The albums themselves are in `get_media_details` |
| `acquisition.id` | Lidarr's artist id, which `set_monitoring` takes with `level: "artist"` and `update_media` takes as `id` |
| `acquisition.status` | Lidarr's own artist status — `continuing` or `ended` — passed through |
| `acquisition.addedAt` | When Lidarr added the artist, so `sort: "added"` works |
| `acquisition.hasFile` | At least one track of any album is on disk, the same meaning `has_file` has for a series |
| `acquisition.path` | The artist's folder |
| `presence` | `both`, `arr_only`, `jellyfin_only` or `unknown`, read exactly as for a film. A media server whose music read did not run reports `unknown`, never `arr_only` |

An artist carries **no** rating and no item-level quality, so `min_rating`,
`rating_source`, `sort: "rating"` and `quality` are refused when `kind:
"artist"` names the question. Without a kind they drop artists, which is what an
absent field means everywhere else here. `watched` and `watched_by` drop
artists the same way, because no music watch state is read: left in, an artist
counts as unwatched and `watched: false` answers with the whole music
collection. With `kind: "artist"` named, they are refused instead. `sort:
"added"` works, because Lidarr reports an added date for an artist.

The media server's music read runs only when a Lidarr is configured. With no
Lidarr there is no artist row to join to, so the read would only add every
artist the server holds as `jellyfin_only`.

**Album ids are one call down.** `get_media_details` on an artist returns its
`albums`, each with the Lidarr album `id` that `set_monitoring` takes with `level:
"album"`. Nothing in `get_library` returns an album id, because the library does
not row on albums.

`search_media` with `source: "library"` finds an artist by **name** — "do I have
any Daft Punk" is a library question, and the artist row answers it.
`source: "discover"`, which is what `lookup_media` runs, answers with Lidarr's
artist lookup: artists to add, each with its MusicBrainz id under `ids.mbid`
and, for one not yet in Lidarr, as `id` too. That id is what `add_media` takes
as `external_id` for Lidarr.

### Books, from Grimmory

Grimmory adds a fourth `kind`, `book`. Its rows are their own source: a book has
no external id, so it never merges with another row, and no media server reads
books, so `presence` is always `unknown`.

| Field | Meaning for a book |
| --- | --- |
| `title` | `<title> by <authors>`, fenced like every other service string |
| `acquisition.id` | Grimmory's book id, which `get_media_details` takes with `service: "grimmory"` |
| `acquisition.quality` | The format of the primary file, such as `EPUB` |
| `acquisition.sizeBytes` | The size of the primary file |
| `acquisition.addedAt` | When Grimmory added the book, so `sort: "added"` and `added_since` work |
| `acquisition.hasFile` | Whether the book has a primary file |
| `playback.watched` | Whether the Grimmory account arr-mcp signs in as has marked the book READ. Unread, unset and never opened all read `false` |
| `library` | The name of the Grimmory library the book sits in, fenced |

A book carries no rating or monitoring. `min_rating`, `rating_source`,
`sort: "rating"`, `watched_by`, `presence` and `monitored` are refused when
`kind: "book"` names the question. Without a kind they drop books, as they do
artists.

Three filters are for books:

- `library` names a Grimmory library, matched ignoring case. It is refused with
  any `kind` other than `book`, and without a kind it drops everything that is
  not a book.
- `quality` matches the format of the primary file, such as `EPUB` or `CBZ`.
- `added_since` takes an ISO 8601 date or timestamp and keeps the books added at
  or after it.

`watched` reads a book's status for the one Grimmory account arr-mcp signs in
as. READ is watched, and every other status, or none, is unwatched. `watched_by`
cannot ask about anyone else and is refused for a book. `set_watched` changes the
status, with `item_id: "grimmory:<book id>"`.

Books are read 200 to a page. A library of more than 20,000 books fails with an
error instead of paging on. An unreachable Grimmory lands in `degraded`, and does
not make a film or series answer less certain.

`search_media` with `source: "library"` finds a book by title or author, and
returns up to 20 hits with the book id. `source: "discover"` returns nothing from
Grimmory. `get_media_details` takes `service: "grimmory"` and that id, and answers
with the book's library, authors, series, ISBN and ASIN when it has them, its
metadata match score, when it was added, and each file with its format and size.
Asking by title alone does not reach a book, and the refusal points to the
`service` and `id` form.

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

### Which media server has it

With [Plex and Jellyfin both configured](configuration.md#plex-and-jellyfin-together),
`presence`, `playback` and `seasons` still describe the primary alone. Each
record also carries `media_servers`, saying per server whether it has the item:

```json
"media_servers": {
  "jellyfin": { "present": true, "itemId": "9f3c..." },
  "plex":     { "present": false }
}
```

`itemId` is that server's own id for the item, present when `present` is true.
A server arr-mcp did not read is **omitted**, never reported `present: false`:
the key is missing when the server was down, or when it is a Jellyfin secondary
with no `default_user`, or a secondary whose `default_user` matches nobody (the
`note` then names the setting). A Plex secondary with no `default_user` is read
as the token's owner. The secondary is read as
its own `default_user`, not as the `user` you pass, since names rarely match
across servers. A failed read of it lands in `degraded` by name and leaves
`presence` alone.

The secondary is matched to the primary's items on shared tmdb, tvdb or imdb
ids only, so an item it holds without any of them reads `present: false`.

`missing_from` takes a server id and keeps the items that server reported it
does not have. An omitted entry never matches, so a server that could not be
read gives an empty answer rather than a wrong one. It is offered only when two
media servers are configured.

Items only the secondary has do not appear in `get_library`, because the join
runs against the primary. `search_media` finds them.

A single-server stack sees none of this: no `media_servers` key, no
`missing_from`.

### Which audio languages a file carries

Anything with a file carries `audioLanguages`: the track languages the service
read off the file itself, slash-joined the way the *arrs write them (`jpn/eng`).
It sits on each episode row for a series and on the record itself for a film, so
a series needs `detail: "full"` and a film does not.

This is the field that answers "is the English dub here". A `MULTi` or `Dual
Audio` in a `get_history` release name describes how the grab was labelled, not
what landed on disk, and a later upgrade replaces the file without replacing
that label.

It is **absent, never empty**, when there is no file — and also when there is
one the service holds no media info for, such as an import that predates a
rescan or a file whose probe failed. Absent means "not known", not "no audio".

**One entry per language, not per track.** The *arrs write one entry per audio
stream, so a file with six English tracks reaches them as
`eng/eng/eng/eng/eng/eng`, which reads as six languages. Repeats are collapsed
and first-seen order kept, so the primary track stays first and `ger/eng` still
means what it looks like. If you want the number of streams rather than the set
of languages, that is a different field upstream and this one will not give it
to you.

Sonarr and Whisparr answer it from a second read of `/api/v3/episodefile`, since
`/api/v3/episode` carries no media info. Radarr needs no extra call: the movie
payload already embeds its file. A failed second read costs the field and
nothing else — the episodes still come back.

Unlike the free text beside it, the value is not fenced. It exists to be matched
against, and a boundary marker wrapped around `jpn/eng` would make its one job
harder; the code points `fenceText` strips are removed from it all the same.

### What a cleanup service is about to do to it

With Reclaimerr configured, a record carries `cleanup`, on both the title and
the `service` plus `id` forms:

- `candidates`, soonest first: what its rules matched on this title, with the
  scope (the whole title, one movie version, a season or an episode), the rules,
  `operation` (`delete` or `move`), `state` and `eligibleAt`.
- `protections`: the active protections on it, with `permanent` or `expiresAt`.
- `removals`, newest first: what it deleted or moved of this title in the last
  year.

The title is found by its TMDB id, the one id Reclaimerr's candidates,
protections and events all carry. `cleanup` is **absent** when Reclaimerr has
nothing on the title, when the title has no TMDB id, and when Reclaimerr could
not be read.

`diagnose` reads the same thing. A removal of the film (or its version, since
Radarr keeps one file per movie) or of the whole series explains a missing file
only when the managing *arr imported nothing after it. A season or episode
removal is mentioned beside the verdict instead, since the rest may still be on
disk, and so is a version removal on a film that still has a file.

## `get_playback`

`scope` picks which of three Jellyfin reads answers the call, and defaults to
`active` — every existing caller sees the same output it always has.

`scope: "active"` (the default): what can be continued comes from
`/UserItems/Resume`, Jellyfin's own answer to the question.
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

That read alone misses plays that never set the played flag. An offline client
such as AFinity syncs its plays back when it reconnects, and Jellyfin logs them
as `VideoPlaybackStopped` in the activity log without ever marking the item
played. So history also reads `/System/ActivityLog/Entries?type=VideoPlaybackStopped`
(newest 500 for the whole household, narrowed to the user by `UserId`), keeps the
newest stop per item, drops anything already in the played list, and looks the
rest up with `/Items?ids=…&Fields=UserData`. Every Jellyfin history row says
where it came from in `source`: `marked_played` or `activity_log`.

A logged play counts as `kind: "watched"` unless Jellyfin still holds a resume
position for it, which means the viewer stopped partway: that row is
`kind: "partially_watched"` with `percentComplete`. Logged items that are not
movies or episodes (live TV) are dropped. An item deleted since keeps its row,
titled with the log entry's own sentence, which Jellyfin localises, and
`removedFromLibrary: true`: whether it was ever marked played cannot be told
any more, and a cleanup tool deleting played items is the usual reason it is
gone.

Two limits. The log reaches back only `ActivityLogRetentionDays` (30 by
default). And a play that left nothing in the log is invisible here. If the
log read fails, history answers from the played list alone and logs a warning;
the played list stays a correct answer to most questions.

Every scope sends an explicit `Limit=500` (`next_up` gets whatever Jellyfin
reports, which does not grow unbounded), so truncation is decided by `limit`
(default 50, like every other tool) and reported honestly through `truncated`,
rather than by however many rows an undocumented server page size happens to
hand back.

The tool is not Jellyfin-specific in its plumbing: it reads any adapter that
implements `PlaybackCapable`, and the summary line names whichever media server
failed. The endpoint detail above is Jellyfin's; Plex answers the same three
scopes from `/status/sessions`, `/library/onDeck` and
`/status/sessions/history/all`. With both configured, the call answers from the
primary; pass `service` (`jellyfin` or `plex`) to ask the other. The answers are
never merged. `service` exists only when two media servers are configured, and
`user` is resolved on the server you chose.

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

`set_watched`, below, remains Jellyfin-only, whichever server is primary. The
Plex adapter writes with `trigger_scan` and `fix_metadata`, and `fix_metadata`
has its own switch there, see [Repairing on Plex](#repairing-on-plex).

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

Each Radarr, Sonarr or Lidarr row carries `downloadId`, the download client's
own id for that grab. It is what `trigger_scan`'s `import` action takes, and
it is the link between "this is stuck at `importBlocked`" and doing something
about it.

Radarr, Sonarr and Lidarr rows also carry `mediaId`, the *arr's own id for the
movie, series or artist the grab is for, and an orphaned row has none. `diagnose`
matches a row to a title by that id first, and falls back to the release name
only when a row has none or comes from another instance.

Lidarr rows carry `statusMessages` the same way, and `orphaned` when the
artist they were grabbed for has been deleted.

NZBGet rows come from its own queue (`listgroups`). Sizes arrive in megabytes
and are converted to bytes. The ETA is worked out from the current download
rate and everything ahead in the queue, and a paused item gets none. A row's
`downloadId` is the `drone` post-processing parameter Radarr and Sonarr attach
to their grabs, so it matches the *arr row for the same download; a grab
added by hand falls back to NZBGet's own `NZBID`.

A blocked row also carries `statusMessages`, the service's own reasons, one per
line and fenced. A file the service rejected leads with its filename. They
tell a retry apart from a dead end: "Series title mismatch" or an unknown
episode fails the same way every time, so `trigger_scan`'s `import` will not
help. Past ten lines the rest are counted, not listed.

### Grimmory's Bookdrop

With Grimmory configured, the files waiting in its Bookdrop are queue rows. Each
has `status: "pending review"`, the file name as its title, and `addedAt` when it
arrived. They are not downloads: arr-mcp has no progress or ETA for them, and
they leave the queue when someone finalises them in Grimmory. Reading the
Bookdrop needs `canAccessBookdrop` on a non-admin account. It is read 100 files
to a page, and a Bookdrop of more than 1,000 files fails with an error instead
of paging on.

`remove_queue_item` with `service: "grimmory"` and the row's `id` discards the
file. Grimmory deletes it from disk and does not import it, so there is no undo,
and `remove_from_client: false` is refused because there is no way to discard
and keep it. The preview names the file and says so. It is `destructive` and
needs `canAccessBookdrop` on a non-admin account. `blocklist` does nothing here,
and the preview says it is ignored.

### Seeding, at `detail: "full"`

Torrent rows carry `private` when the client says, and a finished torrent
carries `seeding`: `ratio`, `seedingSeconds`, the `ratioLimit` and
`seedingLimitSeconds` the client actually applies to it (absent means none),
`ownLimit` when the torrent overrides the client default, and `overLimit` once
it has reached one. The flags only ever appear as `true`. A row that is still
seeding past its limit says so in its line.

The limits are the client's effective ones. qBittorrent resolves torrent,
category and global itself; Transmission's per-torrent mode is resolved against
its session default here. qBittorrent skips share limits for force-started
torrents, so those carry `forced` and the line says why the limit did nothing.
Transmission has no seeding-time limit, only a ratio.

### Cleanuparr rules, at `detail: "full"`

A torrent that a Cleanuparr rule governs carries `seeding.cleanuparr`: `rule`
(its name), `action` (`delete`, `stop` or `unknown`), the limits it sets
(`ratioLimit`, `seedingLimitSeconds`, `minSeedSeconds`), and flags that only
appear as `true` or text when relevant. `dryRun` means Cleanuparr only logs.
`notEnforced` means its Download Cleaner is not scheduled (one that is running
right now counts as scheduled). `uncertain` says why the rule cannot be judged
from here: it filters on seeder count or last activity, or a tracker rule above
it might be Cleanuparr's pick but the client named no working tracker.
qBittorrent names only a tracker that is working right now, while Cleanuparr
reads them all.

Instead of a rule it can carry `{ skipped: reason }`: the torrent is not
seeding, is ignored in Cleanuparr, is still in an *arr queue, is already
stopped, or the rule's action is unknown.

A torrent on a mapped client that no rule covers carries `{ unmatched: reason }`,
the first filter that ruled every rule out, in Cleanuparr's order: `no category`,
`category not in any rule`, `tracker not in any rule` (or `tracker unknown` when
the client named no working tracker), `tags not in any rule`, then
`privacy mismatch`, or `privacy unknown` when the client did not say whether
the torrent is private. Cleanuparr reads such a torrent as public, so a public
rule takes it and only a private one leaves it unmatched. Torrent rows carry their `category` and `tags`, and an
unmatched one its `savePath` too, so the reason can be checked.

A download Cleanuparr has struck, torrent or *arr row, carries `strikes`, one
entry per kind of strike, since Cleanuparr counts and resets each kind on its own
and dry-run strikes apart from real ones. Each has the `count` since that kind's
last reset, the `reason` (`stalled`, `slow speed`, `dead torrent` and so on),
`lastAt`, when the latest one landed, and `dryRun` when Cleanuparr only logged
it. Real strikes come first, then the highest count. They come from the last 30
days of its events.
Strikes on a client since deleted from Cleanuparr are left out: a torrent moved
to another client starts its count afresh there.

When the rule applies and is certain, `overLimit` is judged against it, not the
client's limit, and `limitSource: "cleanuparr"` says so. When it is uncertain,
or the rule sets neither a ratio nor a time limit, the client's own verdict
stays. Rules only reach a client whose host, port and
type match one of Cleanuparr's; see
[Cleanuparr](configuration.md#cleanuparr).

#### When a rule falls due

A rule that is certain and scheduled (no `uncertain`, no `notEnforced`) also
carries `dueAt`, to the second, when its `action` falls due. It is named for
the action rather than for removal because a `stop` rule stops the torrent and
leaves it in the client.

- Past the rule already: the Download Cleaner's next run, read from its job, or
  now when Cleanuparr gave none or that run is already behind.
- A seed-time limit still ahead: now plus the seed time left. If the next run
  comes later than that, it is the next run.
- A ratio already reached, held back only by the minimum seed time: now plus
  the minimum time left.
- A ratio still to climb depends on upload, which no clock projects, so such a
  rule gets no `dueAt` until the torrent is past it.

A limit reached after the next run is acted on at the first run after it, which
only the cron could name, so `dueAt` is then the moment the limit is reached
and Cleanuparr acts at most one interval later. In dry run it is still given,
beside `dryRun`, because it says when Cleanuparr would log the action.

The answer also carries `cleanuparrDue` when anything falls due within 7 days:
`count` and `sizeBytes` per action (`delete`, `stop`), plus `dryRun` when
Cleanuparr only logs. It covers the whole queue, not just the returned page, and
the summary line says it in one sentence, such as "Cleanuparr is due to delete
3 (12.4 GB) and stop 1 (700 MB) in the next 7 days."

Neither client can express a rule like "public trackers stop now, private ones
seed to 1.0". `private` is there so that question can still be asked of the
queue. The qBittorrent side is written against its source at release-5.2.4 and
was checked live on 5.3.0 beside Cleanuparr 2.10.12; `private` needs 5.0 or
later.

## `get_history`

`get_queue` only ever sees what is still in-flight — once a download fails,
imports, or its file gets deleted, it leaves the queue and `get_queue` has
nothing to say about it. `trigger_search` cannot fill that gap either: it hands
back a command handle, and Radarr and Sonarr do not report a search's outcome
through it. `get_history` merges Radarr's, Sonarr's and Lidarr's own history logs with SABnzbd's,
NZBGet's, Bazarr's, Cleanuparr's, Reclaimerr's and Shelfmark's, plus Grimmory's
audit log, and is the only tool that can answer "why did last night's download
fail".

Radarr's and Sonarr's events are normalised to one vocabulary: `grabbed`,
`imported`, `failed`, `deleted`, `renamed`, `ignored` — because they mostly
already agree: both spell a grab `grabbed` and an import
`downloadFolderImported`. The one place they diverge is deletion,
`movieFileDeleted` versus `episodeFileDeleted`, and that is normalised too.
Upstream's own spelling survives as `rawEvent`, and an event this server does
not yet recognise becomes `unknown` rather than being dropped.

`event_type` filters on one normalised type — any of the above, or the ones
the services below add (`subtitle`, `strike`, `protected` and the rest) — and
`since` drops anything older.

A failure's `reason` comes straight from the download client and is fenced
like any other untrusted string — it is not translated, and on a non-English
setup it will not read as English.

**Lidarr** history is merged too, with its own event names mapped onto the
same vocabulary. It has three imports — `artistFolderImported`,
`trackFileImported` and `downloadImported` — and `albumImportIncomplete`
counts as `failed` beside `downloadFailed`: a download that arrived but could
not all be imported. `trackFileRetagged` has no counterpart and reads
`unknown`, with `rawEvent` saying what it was. An `event_type` filter on
`imported` or `failed` sends Lidarr every code for that type, so one album's
`downloadImported` row is not dropped behind its tracks' `trackFileImported`
rows. `id` with `service: "lidarr"` is an artist id, scoped through Lidarr's
`artistIds`, which Lidarr 2.1.3 (the version floor) applies server-side.

### Cleanuparr

Cleanuparr contributes what it did to downloads. Its event types are `strike`
(a download was struck for stalling, being slow or failing to import),
`recovered` (its strikes were reset), `recategorised` (with `oldCategory` and
`newCategory`), `stopped`, `deleted`, `imported` and `unknown`. Its rows carry
`downloadId`, `strikeCount` where it has one, and `dryRun: true` when it only
logged the action. `downloadClient` names the client the event happened on;
`clientRemoved: true` takes its place when that client has since been deleted
from Cleanuparr. A `reason` is fenced like any other upstream text.

`downloadId` is lowercased and links a row to the *arr grab it belongs to.
Radarr, Sonarr and Lidarr rows now carry the same `downloadId`, also lowercased.
`get_queue`'s `downloadId` is as the *arr reports it, so compare the two
case-insensitively. Passing `id` with
`service: cleanuparr` is refused, because Cleanuparr does not keep history per
movie or series.

### Reclaimerr

Reclaimerr contributes its cleanup lifecycle, read from its event feed:
`scheduled` (a rule matched and a deletion date was set), `deleted` (deleted or
moved; `rawEvent` says which), `protected` (a candidate protected, or a
protection created through its API) and `unknown` for a cancel, a postpone or a
timer reset. `reason` carries the rule names and Reclaimerr's own reason,
fenced. Its feed is oldest first, so without `since` arr-mcp reads the last 7
days and widens to 30, 180 and 730 until it holds the rows asked for. A window holding more than 5000 events
would keep its oldest and drop its newest, so arr-mcp halves it towards now
until it fits; what falls before the narrowed start is left out. Passing
`id` with `service: reclaimerr` is refused: its events are per candidate, not
per movie or series, and `get_media_details` shows one title's cleanup state.

### Shelfmark

Shelfmark contributes its book downloads: `imported` for a finished one, `failed`
with its reason, and `stopped` for a cancelled one, with Shelfmark's own word in
`rawEvent`. See [Shelfmark](#shelfmark) under `stack_health` for how much it reads
and what `at` means on its rows. Passing `id` with `service: shelfmark` is refused.

### Grimmory

Grimmory contributes four actions from its audit log. Logins, users, settings
and tasks are never read.

| Audit action | `event` | What a row means |
| --- | --- | --- |
| `BOOK_UPLOADED` | `added` | A book was uploaded to Grimmory. `mediaId` is the book id when Grimmory logs one. No live upload row has been captured yet, so this shape follows Grimmory's API description |
| `BOOK_DELETED` | `deleted` | A book was deleted. The title is the description Grimmory logged, fenced. On 3.5.0 that is a count such as "Deleted 1 book(s)", which names no book. The row has no book id and no `mediaId`, because Grimmory logs none for a delete |
| `METADATA_UPDATED` | `metadata` | A book's metadata was changed. `mediaId` is the book id |
| `LIBRARY_SCANNED` | `scanned` | A library was scanned. The title reads `library <id>` unless Grimmory logged a description |

`rawEvent` holds the audit action. `event_type` can be `added`, `deleted`, `metadata`
or `scanned`. Each action is read on its own, newest first, up to 1,000 rows, so a
busy action does not push out the rows of a quiet one.

The audit log needs a Grimmory admin account. A non-admin account gets an
`AuthFailed` error that says so, and Grimmory lands in `degraded`. No other
permission opens it.

`since` is sent to Grimmory as a UTC time, and a date or a time without an offset
is read as UTC. Grimmory reads that time in its own zone, which a Docker image
keeps at UTC unless `TZ` says otherwise. Audit times that arrive without an
offset are read as UTC too. Rows older than `since` are dropped on arr-mcp's side
as well.

`id` with `service: "grimmory"` is a book id. It keeps the `metadata` rows for
that book and leaves out scans. A `deleted` row never matches, since it names no
id.

### The services below the *arrs

**SABnzbd** contributes its own history: what happened to a download after it
left the queue, one layer below the *arr that asked for it. When Radarr says it
grabbed something and nothing ever arrived, the client's own failure message is
the answer, and it is here. Its rows map onto the same vocabulary — `Completed`
becomes `imported`, `Failed` becomes `failed` — and carry the `fail_message`
as `reason`.

**NZBGet** contributes its history in the same role. Its `Status` is
`<KIND>/<DETAIL>`: `SUCCESS/*` becomes `imported`, `FAILURE/*` becomes
`failed` and `DELETED/*` becomes `deleted`, except that `DELETED/HEALTH` (aborted
because too many articles were missing), `DELETED/BAD` and `DELETED/SCAN` are
`failed`. NZBGet keeps no failure message,
only a status code per post-processing stage, so `reason` is the status plus
the stages that did not succeed, for example
`FAILURE/PAR (ParStatus FAILURE)`. A row also carries `downloadId` (except at
`detail: "minimal"`), the id `trigger_scan`'s `postprocess` takes to run its
post-processing again. It is the `drone` id an *arr stamped on the NZB, or
NZBGet's own id for one added by hand, and is left out when it is not shaped
like an id.

**Bazarr** contributes `subtitle` rows: what it actually downloaded, and from
which provider (in `quality`, as `language · provider`). It is its own event
type on purpose — a downloaded subtitle is not an `imported` grab, and calling
it one would put it in the answer to "what did Radarr import last night".

All three refuse a `service` + `id` scope rather than answering an empty list:
none of them knows what a Radarr movie id or a Sonarr series id means, and an empty
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
profile wants. `get_wanted` answers both, straight from Radarr, Sonarr and
Lidarr's own wanted lists.

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

Lidarr's rows are albums, with Sonarr's trap one level up: Lidarr's own `id`
on the row is the album, so the row is `kind: "artist"`, `id` names the
**artist** and `title` its name, and `albumId` and `albumTitle` say which
album. `albumId` is what `set_monitoring` takes with `level: "album"`, so "stop
wanting this album" goes straight from a row to a write. `airDate` is the
album's release date, left out when Lidarr reports its year-one "no date"
(`0001-01-01`, .NET's `DateTime.MinValue`). On Lidarr, `missing` is a released
album with any track lacking a file, not only one with none, so a partly
downloaded album can be in both lists. Both leave out every album of an
unmonitored artist, as Lidarr's own wanted lists do.

Sonarr's and Lidarr's missing lists are monitored-only, which matches what
"wanted" means here — an unmonitored gap is not something anyone asked for,
and it will not appear in this list.

`detail: "minimal"` drops `episodeTitle`, `albumTitle` and `airDate`, keeping
the identity, `season`/`episode`, `albumId` and `monitored`. None of the three
is grab-plumbing the way `get_history`'s `guid` is — there is nothing to trim
between `standard` and `full` here, since every field is one a reader wants.

## `get_releases`

`trigger_search` asks Radarr or Sonarr to look for a release, but hands back
only a queued command — it cannot show what was found, so nothing can
actually be picked. `get_releases` runs the same interactive search Radarr
and Sonarr's own web UI does and returns every candidate, so a model can
compare them and pick one for `grab_release`.

`service` and either `id` or `title` are required: this searches one movie or
series, or on Shelfmark one book, with `id` from a `lookup_media` row. It never
merges across services the way `get_history` and `get_wanted` do.

A `title` is resolved the way `get_media_details` resolves one, to the id the
named service manages it under, which saves looking the id up first. Two items
matching equally well are refused with both ids rather than guessed between, a
title managed by another service is refused naming that service, and a title
the library lacks gets the same lookup answer `get_media_details` gives.
`season` and `episode` are Sonarr-only, and passing either to a Radarr search
is refused rather than silently dropped. They are mutually exclusive. `episode`
takes one episode id, as `trigger_search`'s `episodes` does, and searches that
episode alone.

Rejected releases are returned, not filtered out. A live capture found
*every* candidate rejected on both a Radarr and a Sonarr search — 2 of 2 and
516 of 516 — almost always because the library already held a file at an
equal or higher quality score. That is the ordinary outcome, and a tool that
hid rejects would have answered empty both times. Each row carries
`rejected` and the `rejections` upstream gave, fenced like every other
release-supplied string.

`guid` and `indexerId` travel together — that pair is what `grab_release`
binds a chosen release to. `seeders` is torrent-only and is absent,
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
At `full`, each row's text line carries both too, next to the indexer
(`V3X (Prowlarr) [indexer_id 5, guid …]`), so a client that never forwards
the structured result can still pass them to `grab_release`. A guid shaped
like an id (no whitespace, brackets or angle brackets) appears bare; any other
is fenced like a title, and that row can be grabbed by `release_title` instead.

This call is slow. Radarr and Sonarr poll every configured indexer
synchronously before answering, and a live capture measured a Sonarr season
search at 14.3 seconds — a cold search across more indexers can run longer.
The tool's own per-call timeout is 120 seconds, well past the 10-second
default every other call uses, specifically so a real search has room to
finish rather than being cut off. A long wait here is not a hang; retrying
it starts a second full indexer sweep.

Sonarr runs one indexer search per episode, so a season search scales with the
season's episode count and a whole-series search with every episode the series
has. To replace one bad episode, pass `episode`: a live search for one episode
returned 339 releases in 58 seconds, where a season could not fit in the
timeout. Retry is already off for this call, so a timeout means one sweep ran
out of time, not two.

On **Lidarr**, `id` is the artist and `album` narrows the search to one of its
albums, from `get_media_details` at `detail: "full"`. The album is read first
and must be the artist's: Lidarr searches an album by its id alone, so a
mismatched pair would list releases for an artist nobody named. A whole-artist
search returns every release matching the artist's name, and ran past a
thousand rows live, so pass `album` when you know it. `season` and `episode`
are refused. Lidarr 3.1.6 names the protocol by its class
(`UsenetDownloadProtocol`), and rows read `usenet` or `torrent` as Radarr's and
Sonarr's do.

## `grab_release`

The write half of `get_releases`. Takes `guid` and `indexer_id` from a
`get_releases` row verbatim and tells Radarr, Sonarr, Whisparr, Lidarr or
Shelfmark to grab that one release — "not that one, the 1080p remux". On Shelfmark both can be left
out, and the most-downloaded file is taken, named in the preview first.

Instead of the ids it takes `release_title`, the release name exactly as
`get_releases` listed it, plus `id`. The preview's re-search looks the name up:
an exact match, ignoring only surrounding whitespace. Two indexers often list
the same release under the same name, so a name that matches more than one row
is refused with each row's `indexer_id` and `guid`. Pass `indexer_id` with the
title to pick one. The token binds to the guid and indexer the title resolved
to, and the confirmation resolves it again, so a re-search that maps the name
to a different row voids the token.

Safe tier, not destructive: a grab starts a download, and a download comes
back off with `remove_queue_item`. Nothing on disk is lost.

Previewing is slow, and deliberately so. The preview re-runs the interactive
search before it will issue a token, which polls every indexer again and can
take tens of seconds. It buys two things. Indexer results expire, and a bare
grab of an expired guid answers a 404 that is indistinguishable from a wrong
base path — the re-search turns that into *"that release is no longer on
offer, call get_releases again"*. And it puts the release's real name in the
preview: "grab release abc" is not something a person can approve.

Pass the same `season` or `episode` `get_releases` was called with, so that
re-search covers the scope you actually searched rather than the whole series,
and on Lidarr the same `album`. All three are refused alongside `magnet`, which
never goes through an *arr and so has no scope to narrow.

A Lidarr grab answers only once Lidarr has handed the release to the download
client, which ran past the 10s default live, so it gets the release-search
timeout. A grab that still times out says it may have gone through: check
`get_queue` or `get_history` before grabbing again, or it may download twice.

The confirmation token binds to **both** `guid` and `indexer_id`. That pair
is what identifies a release, and the candidate list is written by indexers,
so a search running between the preview and the confirmation must not be able
to swap which release the confirmation applies to. A token issued for one
guid is refused for another, and the same for the indexer.

A release the *arr rejected on its own criteria can still be grabbed
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

It skips the *arrs entirely, and the preview says what that means:
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
at the newest few per issue. Who reported an issue, and who made a request, is
fenced too: Seerr users choose their own display names. Unlike the requests, issues are not scoped to one
user: they are what the household has reported.

A Seerr that cannot answer for issues still answers for the requests, and does
not report itself degraded for it.

## `get_blocklist` and `remove_blocklist_item`

The question that sends people here is "it keeps finding the same release and
never downloading it". `get_history` shows that as a grab followed by a
failure, over and over, and explains none of it. The blocklist does: Radarr,
Sonarr, Whisparr and Lidarr record what they will not grab again, and why — usually in
the download client's own words.

Rows carry `mediaId` for `get_media_details` (on a Lidarr row, the artist id)
and `id` for `remove_blocklist_item`, and are newest first, because a blocklist
is read to explain something that has just gone wrong.

`remove_blocklist_item` withdraws one refusal, so the release can be grabbed
again. Safe tier: nothing on disk changes, and the inverse already exists —
`remove_queue_item`'s `blocklist: true` puts a release back on the list, on
Radarr, Sonarr, Whisparr and Lidarr alike. On Lidarr, blocklisting marks the
download failed, and with Lidarr's "redownload failed" setting on (its
default) that also starts a search for a replacement
(`RedownloadFailedDownloadService`, Lidarr 3.1.0).

Its preview reads the live blocklist first, and that is not a courtesy. Both
services answer a `DELETE` of a blocklist id that **does not exist** with
success — probed against a live Radarr and a live Sonarr — so a stale id
would otherwise be reported as removed when nothing had happened. It is the
same trap `remove_queue_item` documents, and it is checked the same way.

## `manage_indexer`

Adds, edits, disables, re-enables or deletes one Prowlarr indexer, then queues
Prowlarr's Application Indexer Sync. Every action but `add` takes `id` from
`get_indexers`: `21` for a row shown as `prowlarr:21`.

What happens to the copies in Radarr and Sonarr depends on each app's sync
level in Prowlarr, so the preview reads `/applications` and says it per app.
From Prowlarr's own source (2.6.5):

| Action | Add and Remove Only | Full Sync | Sync disabled |
| --- | --- | --- | --- |
| `add` | copy added | copy added | nothing |
| `edit` | copy keeps its old settings | copy updated | nothing |
| `disable` | copy stays listed, every search and grab through it fails | copy is disabled too | copy stays listed, every search and grab through it fails |
| `enable` | works again; the sync re-adds a missing copy | copy is enabled again | works again if the copy still exists |
| `delete` | copy removed | copy removed | copy stays and fails; remove it by hand |

An app only gets an indexer when two things line up: its tags are empty or
share one with the indexer, and the indexer covers at least one category the
app syncs (Sonarr's anime categories count). So a movies-only indexer never
reaches Sonarr, and the preview says which of the two kept it out.

### Adding

`add` takes a `definition`, by the name in Prowlarr's Add Indexer list
(`Nyaa.si`) or its definition name (`nyaasi`), and only adds **public indexers
that need no login**: no password, cookie or captcha field. Private and
semi-private ones are refused with a pointer to Prowlarr's UI, because arr-mcp
never handles indexer credentials. Prowlarr's own field flag misses cookies and
most Cardigann passwords, so the check is on the field type too. On a current
Prowlarr that leaves about 88 of its 650 definitions.

The indexer is posted as Prowlarr's own template with only the settings you
named changed, enabled, on your first app profile unless you name another.
Prowlarr tests it before saving, which means a request to the site from
Prowlarr's network; if that fails nothing is added, and Prowlarr's logs have
the reason. A definition already configured is a no-op naming its id.

### Editing

`edit` changes `priority`, `app_profile`, `tags` and the four torrent seed
settings, and nothing else. It goes through Prowlarr's bulk endpoint, which
takes just those fields, so the indexer's credentials never pass through
arr-mcp. That is also why the name, URL and categories are not editable here.

Profiles and tags are named, not numbered, and must already exist; arr-mcp
does not create either. `tags` replaces the whole list, and the preview works
out which apps gain or lose the indexer because of it: Full Sync apps drop a
copy whose tags no longer match, Add and Remove Only apps keep it.

A seed setting that is unset today means the download client's default
applies. Setting it is fine, but the bulk endpoint cannot unset it again, so
the preview says so and only Prowlarr's UI can put it back.

`disable` stops grabs everywhere because Prowlarr answers a disabled indexer's
searches and downloads with `410 Indexer is disabled`, whatever the app thinks
it has. The cost is that an app at Add and Remove Only reports the indexer as
failing until it is enabled again or deleted. An app whose tags exclude the
indexer never had it, and the preview says so.

`add`, `edit`, `disable` and `enable` are safe tier. `delete` is destructive:
Prowlarr keeps nothing to restore, so getting it back means adding the
indexer again, credentials included. The tool is annotated `destructiveHint`
because one of its actions is.

Adding and deleting the same indexer seconds apart can leave a copy behind in
an app: the delete's sync joins the add's, which is still running. The next
sync clears it; `trigger_scan` on Prowlarr runs one.

## `set_watched`

The write half of `get_playback`. Marks a film, series, season or episode
watched or unwatched in Jellyfin, or a Grimmory book read or unread.

`item_id` is a **Jellyfin** item id, and that constraint is deliberate rather
than incidental. Jellyfin's own ids never enter the library index —
`listUserLibrary` carries TMDB, TVDB and IMDb ids only — so an id here can
only have come from the `itemId` `get_playback` reports or from a jellyfin
hit in `search_media`. With Plex as primary, `playback.itemId` is a Plex id;
take the Jellyfin one from `media_servers.jellyfin.itemId` on `get_library` or
`get_media_details`. A Radarr or Sonarr id is a small integer and is
refused before any network call, rather than becoming a 404 that names
nothing.

`title` takes the place of `item_id`: a film or series title, resolved as
`get_media_details` resolves one, to the Jellyfin id on the merged record
(`media_servers.jellyfin.itemId` with two media servers). A tie is refused
with every match's id, since this writes. The confirmation token is bound to
the resolved id, so a title that resolves to something else between the
preview and the confirm is refused rather than written.

A series id with `season` marks that season. The preview reports the **number
of episodes**, not just the season number: "marks season 2 watched" is not
something anyone can weigh. It counts only the episodes that would actually
change, so re-running it on a mostly-watched season says so.

Safe tier, with one caveat stated in every preview: unmarking and re-marking
restores the watched flag but **not** the original play date or resume
position. That history is not recoverable.

`user` names whose watch state changes; anyone but `default_user` needs
`services.jellyfin.allow_other_users`.

### Grimmory

`item_id: "grimmory:<book id>"` marks a book, with the id from `acquisition.id`
on a `get_library` book row. `watched: true` sets the status READ and `false`
sets UNREAD, for the one Grimmory account arr-mcp signs in as. `user` and
`season` are refused, because a book has one reader and no seasons. A bare number
is a Radarr or Sonarr id and is refused as before.

The preview says what changes. Marking a book read sets its finish date to now.
Marking it unread clears the finish date, and an earlier one is not restored. A
book already in the status asked for is a no-op. Safe tier. A non-admin account
needs no permission beyond access to the book.

**Plex is read-only here, by design.** `get_playback` reads Plex watch state,
but `set_watched` never writes it. With only Plex configured the tool refuses
and says to add Jellyfin alongside Plex; it does not suggest replacing Plex.

## `get_metadata_issues`

The discovery half. `fix_metadata` only ever looks at a series you already
suspect, and on a real library you mostly do not know which to suspect —
sweeping 101 series turned up two problems nobody had noticed beside the one
that prompted the work.

Covers films and series, and Grimmory books in a sweep of their own (see
[Books that need a repair](#books-that-need-a-repair) below). Films cost one
request for the whole library, because
they need no per-title read; series cost one each, which is why this is
deliberately **not** folded into `get_library` where every caller would pay for
it. A real library of 101 series and 118 films sweeps in seconds.

It works on Jellyfin and Plex. The detector was tuned on Jellyfin libraries,
101 real series of them, then on a sweep of a real Plex library of 5,988 items
in [#312](../../../issues/312). That sweep moved four rules: a film's year may
drift by two, a matched film whose year agrees is not flagged on its title
alone (Mad Max 2 shown as The Road Warrior), an episode title is compared
against every field in the filename including parentheses (`Chapter One - The
Boy in the Iceberg` shown as "The Boy in the Iceberg"), and accents are folded
before comparing. A rerun moved three more: a multi-episode file
(`S04E10-E11`) matches every episode in its range, specials whose file and
server both say season 0 are never a numbering finding, and an episode whose
title belongs to the episode next to it is marked as shifted (Cowboy Bebop,
TNG and 20 more series on that library). The rerun on 1.44.0 widened that to
any episode in the same season, for shifts of two or more and reordered
seasons (Goof Troop, Tales from the Crypt). A file that names two segments,
`Bats in the Basement (Mario and the Beanstalk)`, is checked on both halves.

An episode whose filename and server title are in different languages is
marked too (`El monstruo del mar` shown as "The Monster of the Sea"). The
language is guessed from function words such as `el`, `the`, `der` or `het`,
for English, Spanish, French, German, Italian, Portuguese and Dutch. A title
gets a language only when at least two of its function words point at one
language, one of them a word no other language on the list uses, and it
clearly wins. "Wrath as a Lightning" is not Portuguese: `as` and `a` are
English too. A title too short to place on its own takes the series' language
when it has a function word of that language, so a Spanish series of
two-word titles still reads as Spanish. A title with no function words at all
takes it only when the other side is clearly another language by its own
words ("One Man's Many Faces" against "Las Muchas Caras de Un Hombre").

Shifted episodes, specials and language differences are real disagreements that
a rematch does not fix, so they are counted in `shifted`, `specials` and
`languages`, and never on their own push a series to `refresh_metadata`. A
rematch was measured not to move a shifted series. Placeholder titles in the
server are the other finding a repair cannot fix.

A Plex film matched to a provider id whose year alone disagrees with its file
gets `inspect`, not `refresh_metadata`. The repair re-matches the id Plex
already holds and the Plex Movie agent keeps Plex's own year, so on the #312
library none of those years moved. On Jellyfin the same film still gets
`refresh_metadata`, because Jellyfin refreshes a film's year from TMDB.
Plex episodes are never treated as pinned: their provider ids follow from the
show's match rather than identifying the episode on its own, so a title-only
finding on Plex comes back as `refresh_metadata`. If the sweep flags something
on a Plex library that is actually fine, please open an issue with the filename
and the title Plex shows.

A series item whose files sit in the folders of more than one Sonarr series
gets `inspect` too, whatever its mismatches say. That is separate shows merged
into one item (two folders, two TVDB ids), and a repair would re-identify it
against the id it already holds. The row says to use Split on the item in Plex,
and `fix_metadata` previews the same without offering a token. Folders are
matched by name and parent folders, so Sonarr and the media server can mount
the disk at different roots. With no Sonarr configured nothing changes.

With two media servers it sweeps the primary; `service` picks the other.

Each row prints its item as `service:itemId`. Pass that to `fix_metadata` as
`id` to repair exactly the item that was flagged, since a title can resolve to
a different one.

### Books that need a repair

With Grimmory configured, the sweep also lists books whose match score is under
45. A book with a good score but no ISBN is not listed: its metadata matched, it
only lacks an id, and `fix_metadata` still takes it by `grimmory:<id>`. A book
with no score is not listed either.

A listed book with no ISBN costs one extra read to check the catalogue ids
Grimmory holds for it (ASIN, Goodreads, Google, Hardcover, Hardcover book, Open
Library, Comic Vine, Douban, Lubimyczytac, Ranobedb, Audible or Apple Books).
With none of them, `fix_metadata` can only search by title and author, and the
row says so. When that read fails the book is still listed for its score. A
login or connection failure ends the sweep, and Grimmory lands in `degraded`.
Grimmory's list is read 200 books to a page.

A book row has `kind: "book"`, prints its item as `grimmory:<book id>`, carries
`matchScore` when Grimmory has one, and counts one mismatch. Its `reason` says
why it is listed: `low match score (N)`, plus `and no ISBN or catalogue id` when it has
neither. Its `remedy` is
`refresh_metadata`, whose `fix` is `fix_metadata` with that id, or
`unlock_fields` when every metadata field on the book is locked. `itemsScanned`
counts the books read. A Grimmory that cannot be read lands in `degraded` and
the films and series still answer. Reading needs a user who can see the
libraries, and no other Grimmory permission.

### `remedy` is the field that matters

A title mismatch says the file and the server disagree. It does not say which
one is wrong, and both directions are real. What separates them is whether the
server ever matched the episode:

| `remedy` | Means | What to run |
| --- | --- | --- |
| `refresh_metadata` | No provider ids, so the server never matched it and holds nothing for the file to contradict. Also every film whose year disagrees, since re-identifying re-derives a film's year. | `fix_metadata` |
| `rename_files` | Every `numbering` finding: an episode's season and number are stored at scan time, so only the file can change. | `trigger_scan` rename on the managing Radarr or Sonarr, then a media server rescan |
| `inspect` | The server matched it and only the wording disagrees, which a correct title in another language does too. Also a series whose mismatches are all shifted titles, specials or titles in another language. | Look first, against the managing Radarr or Sonarr |
| `unlock_fields` | The disagreeing field is locked on the item, or on Jellyfin the whole item is, so no rematch or refresh will change it. | Unlock it on the item in the media server if it is wrong, then `fix_metadata` |

Three real series stand behind that rule, which is enough to act on and not
enough to be certain — treat it as the likely fix rather than a verdict:

- A series whose episodes were titled after the series itself, with no provider
  ids. `fix_metadata` repaired both episodes.
- A series where the first three files carried titles belonging to episodes 7,
  4 and 6. The server *and* Sonarr both had it right; the filenames were wrong.
- Dragon Ball Kai, where a refresh changed nothing twice.

Rows are worst-first: `numbering` findings outrank title ones, then sheer count.
`itemsScanned` is the denominator — without it, "0 problems" and "0 series
looked at" read identically.

## `fix_metadata`

The repair `trigger_scan` was never for. A scan asks whether a file is on
disk; this asks whether the metadata bolted to that file **describes** it, and
replaces it when it does not. The case it exists for: a file named
`Specials/Episode 101 Videl's Crisis…` displayed as S1E1 *Prologue to Battle!*,
which a scan reports as perfectly fine because the file is exactly where it
should be.

A Grimmory book is repaired too, by its id and through Grimmory's own metadata
providers; see [A Grimmory book](#a-grimmory-book) below. A title that matches
only a book is refused, and the refusal names the id form.

Give a film or series title as `query`, resolved through the library index the
same way `get_media_details` resolves one, or the `id` that
`get_metadata_issues` printed for it (`plex:119962`, or bare). The id wins when
both are given.

With two media servers it repairs on the primary. `service` picks the other, and
an `id` prefixed `plex:` or `jellyfin:` picks its own server. Plex repair still
needs `allow_metadata_repair` on the Plex block, whichever server is primary.

### The two findings are not equally trustworthy

The preview splits them, because acting on them differently is the point:

- **`numbering`** — the season or episode number the *path itself* states
  disagrees with the server's. A `SxxExx` or a `Specials` folder is an
  explicit claim, not an inference, so this is the confident half.
- **`title`** — the filename and the server's title share no meaningful word.
  Advisory only. A romanised filename against an English title disagrees
  completely while both are correct, and that is common enough that a title
  finding alone is a reason to look, not a reason to repair.

Short words and stopwords are excluded from that comparison. Without it "the"
and "of" satisfy the overlap test and it never fires.

The preview lists the offending filenames themselves, up to five. A count on
its own is not approvable for a write of this tier — the person confirming has
to be able to see what the tool believes is wrong.

### What it actually does on Jellyfin

On confirm, **one** call. `/Items/RemoteSearch/Apply/{id}` with the TVDB id for
a series or TMDB for a film is not just a pin: checked against the server
source, it sets the provider ids and then awaits a full refresh itself, with
`ReplaceAllMetadata` and `RemoveOldMetadata`, before answering. A second
`/Refresh` would be another full provider fetch of the same item for nothing.

That call is **synchronous**, so when it returns the metadata is settled and
the before/after comparison is a final answer. With no provider id to pin there
is nothing to identify against, so the fallback is a plain `/Refresh`, which the
server *queues* — there the comparison is a snapshot mid-flight, and the result
says which of the two happened rather than hedging over both.
TVDB is preferred because Sonarr is the source of truth for a series and its
id is what the file layout was built from. When no provider id is known the
identify step is **skipped rather than guessed** — applying an empty match
would unpin whatever identity the item already had — and the preview says so.

The identify call is **slow**, and the timeout on it is raised to 120s for
that reason. Jellyfin holds the request open while it talks to the provider and
rebuilds the item; the first live run of this tool, against a 69-episode
series, exceeded the ordinary 10s service timeout and the repair never landed
at all. A long wait here is not a hang — retrying starts a second full
rematch.

**Destructive tier, and not as a formality.** `replaceAllMetadata` overwrites
every field the server held, including anything corrected by hand in Jellyfin,
unless it is locked. There is no undo on Jellyfin; for Plex see below.

**Locks are respected, and read.** Checked against `MetadataService.cs` at
v12.1: a locked item ("Lock this item to prevent future metadata changes")
makes a refresh skip every provider, and a field unchecked under Enabled Fields
is kept. Jellyfin has no lock for the year, so a locked `Name` is the only
per-field lock a mismatch can be about. Both reads ask for `Fields=Settings`,
which is what puts `LockData` and `LockedFields` on list rows. When what
disagrees is locked, the preview says so and issues no token, and
`get_metadata_issues` gives it the remedy `unlock_fields`.

### When it will not help, said before you confirm

A full refresh re-fetches each episode **from the provider id stored on that
episode**, not from the series. So an episode pinned to the *wrong* id is
re-written with the same wrong metadata, and the repair completes having
changed nothing.

This is not theoretical — it is what the first live run did. All 68 mismatching
Dragon Ball Kai episodes carried their own AniDB, IMDb and TVDB ids
(`Episode 101 Videl's Crisis…` pinned to Tvdb `507731`, which *is* Kai S1E1
*Prologue to Battle!*). The repair applied cleanly, reported success, and every
title came back identical.

Clearing those ids does not help either, which was measured rather than
assumed: one episode had its provider ids cleared and a full refresh run
against it alone, and its season, number and title all came back unchanged.
An episode's numbering and title are stored **on the item** from the original
scan, and a refresh does not re-derive them from the file. That is why this
tool does not offer to clear them — it would be a large destructive capability
that provably changes nothing.

The preview therefore reads `ProviderIds` alongside `Path` and leads with
**EXPECTED TO ACHIEVE NOTHING** when every mismatching episode is pinned, or a
proportional warning when only some are, and it names the repair that does
work. That repair is two tools that already exist, not this one:

1. `trigger_scan` with `action: "rename"` on the **Sonarr** series, which
   renames the files to Sonarr's own naming scheme — Sonarr holds the correct
   mapping, so the files come out with proper `SxxExx` names.
2. `trigger_scan` on the **media server**, so the renamed files are scanned in and
   parsed correctly.

The result of an applied repair carries `mismatchesBefore`, `mismatchesAfter`,
`comparedBefore`, `comparedAfter` and `verified`. `verified: true` means fewer
mismatches, with at least as many items compared as before, and for a queued
refresh that it held across two reads.

### Films are judged on their year

A film has no episode numbering, so the **year** does that job, and it does it
well: a film file names its year almost universally, and a year that disagrees
means the server matched a *different film* rather than the same one worded
differently. The title check runs too, as the advisory half, exactly as it does
for an episode.

Only the parenthesised `(YYYY)` form counts, and that is a precision guard
rather than pedantry. A bare four-digit token is not a year, it is a number that
looks like one — `Blade Runner 2049 (2017)` parsed as year 2049 with the title
"Blade Runner", which then disagreed with a perfectly correct record. `1917` and
`2012` are the same trap. No parenthesised year, no claim.

A drift of up to two years is not a finding. Radarr names a file with the year
it held at import, and festival, limited and regional dates move it afterwards;
on a real Plex library, nearly every film flagged at a one-year tolerance was
the right film two years out. Three years or more still is. And a film the
server matched, whose year agrees, is never flagged on its title alone: that is
the same film under an alternate or regional title.

Swept across a real library of 118 films, this produced no findings at all,
which is the answer a healthy film library should give.

### Two things it deliberately will not do

**An episode the server never matched at all reads as clean.** When Jellyfin
cannot match an episode it falls back to naming it after the file, so the
filename and the title agree perfectly and both checks pass. Verified on the
real Dragon Ball Kai series: 68 of its 69 episodes were flagged, and the one
that was not is the one Jellyfin holds no metadata for — its title is
literally its filename. The count is therefore a floor, not a total. It costs
nothing in practice, because the repair is applied to the whole series rather
than to the episodes named in the preview.

**A series whose episodes came back with no file paths is an error, not a
clean bill of health.** "Nothing was compared" and "nothing is wrong" arrive at
the same count of zero, and reporting the first as the second is the
reassuring lie the preview exists to prevent. Jellyfin returns `Path` only to
a read that asks for it and only for a user who may see it.

### A Grimmory book

`id: "grimmory:<book id>"` repairs a book, as `get_metadata_issues` prints it.
`isbn` searches the providers by that ISBN instead of the book's own. It takes 10
or 13 digits, and an ISBN-10 may end in X. `isbn` is refused with any other id,
and `service` and `user` are refused for a book.

The preview asks every metadata provider enabled in Grimmory about the book and
saves nothing. It searches by the ISBN, the one passed or the one the book holds,
and otherwise by title and first author. A candidate is taken only when its ISBN
equals the one searched, or when its title and its first author both equal the
book's. A title alone never qualifies, because another author's book of the same
name would replace this one's identifiers. An ISBN match beats a title match. If
no candidate qualifies, the preview is a no-op that says how many answers came
back and suggests passing `isbn`. With no provider enabled the call is refused.

The preview lists each field the best match would change, old value to new.
Every field is considered except categories, and the cover and the description
are left alone. A locked field is never sent, and the preview names the ones it
left. A book with every field locked is a no-op that says to unlock it in
Grimmory first.

Grimmory may also write the change into the book file and move it to match its
naming pattern, when its metadata settings say so. There is no undo. Applying
looks the providers up again, so a provider that now answers differently gives a
fresh preview and the token is refused.

`destructive` tier. A non-admin account needs `canEditMetadata`.

### Waiting on a queued refresh

Plex always refreshes in the background, and so does Jellyfin's plain refresh,
and neither says when it is done. A single read straight afterwards was wrong in
three of four live Plex applies: twice it caught a show mid-rebuild with almost
nothing to compare and called that repaired, and once it read a film before the
refresh landed and called that a failure.

So apply reads again every 5 seconds for up to 30. It only reports `Repaired`
when the count dropped, at least as many items were compared as before, and the
same count came back on the next read. Otherwise the result is `NOT VERIFIED`,
and says whether the item was still rebuilding or the count simply did not move.
Run `get_metadata_issues` again a few minutes later for the settled answer.

A read that fails during the wait counts as "not settled yet", because the write
has already landed and Plex answers 503 while it refreshes an item. If every
read fails, the result is `NOT VERIFIED` and says so, rather than an error.

### Repairing on Plex

Plex repair is on by default, behind `permissions.destructive: true` as for any
destructive write. Film and series repairs have both been checked against a live
Plex server. Switch it off with `services.plex.allow_metadata_repair: false` (the
checkbox on the Plex card in the config UI). The two are
separate switches: `stack_health` and `arr://instances` report
`permissions.destructive` as `config.yaml` and your token allow, and know nothing of
`allow_metadata_repair`, which `fix_metadata` checks on top of it. While it is
off, a `dry_run` preview still lists the real mismatches, but the write is
refused with `Plex repair is off`, no confirmation token is issued, and the
audit log records it as denied.

The repair is Plex's own Fix Match, driven the way python-plexapi drives it:

1. Read the item's library, and that library's agent and language.
2. Search for matches with the provider id as the title: `tvdb-N` for a
   series, `tmdb-N` for a film.
3. Apply the single result with `PUT /library/metadata/{id}/match`.
4. Refresh with `PUT /library/metadata/{id}/refresh?force=1`.

With no provider id it skips steps 1 to 3 and only refreshes, on any agent.

- **Matching by id needs Plex's current agents**, Plex TV Series or Plex
  Movie. Only those accept an id as the search title. An id match on a legacy
  agent is refused with a message saying so; a refresh-only repair and
  detection still work there.
- **Exactly one candidate, or nothing.** If the id search finds none, or more
  than one, the repair stops before writing and says how many it found.
- **The match and refresh calls wait up to 120s**, the same allowance as
  Jellyfin's identify call. If the match step times out it may have been
  applied anyway, and the error says to check the item in Plex first.
- **Plex refreshes in the background**, so applying waits for the result to
  settle, as described [above](#waiting-on-a-queued-refresh).
- **Locked fields are kept.** Plex locks a field when it is edited by hand, and
  fields get locked in other ways too, so a lock is not proof of a hand edit.
  Neither Fix Match nor a refresh overwrites one. Plex leaves locks out of its
  list responses (section listings and `allLeaves`), so both tools re-read the
  mismatching items by id to see them. When the field that disagrees is locked,
  the preview says so and issues no token, and `get_metadata_issues` gives it
  the remedy `unlock_fields`. Unlock it on the item in Plex (Edit, then the lock
  icon beside the field) if the locked value is the wrong one.
- **The result names what Plex matched the item to**, with its year when Plex
  gives one, so a wrong match shows before the refresh settles.
- **A numbering mismatch usually needs a rename, not a rematch.** Plex takes
  season and episode numbers from the file names, and the preview says so when
  it finds one.
- **Undo** is Fix Match or Unmatch on the item in Plex itself.
- Every call goes to the server at `url`. Nothing goes near plex.tv.

**What is verified.** The match flow (`/matches`, `match`, `refresh`) ran
against a real Plex 1.43.4 in [#312](../../../issues/312). A film whose year was
wrong was repaired once its locked date was unlocked. Two series rematched
cleanly and kept their wrong episode titles, so a rematch does not fix every
series finding yet, and the default stays off until it does. Reports on #312
are still welcome.

## `get_profile_issues`

Faults in Radarr, Sonarr and Whisparr quality profiles and custom formats —
the configuration mistakes that make a profile unable to do what it looks
like it does. Read-only, and deliberately so: Profilarr owns quality profiles
and custom formats, re-syncing them from its own git source, so a direct
write here would be reverted on the next sync or reported back as drift.
Every `remedy` is a change to make **in Profilarr** when it syncs the profile,
or in the arr itself when it does not, never one this tool performs.
Profilarr's API says how many profiles it syncs to each arr but not which, so
the remedy names both places.

Six finding kinds, each carrying a `confidence`:

| `kind` | `confidence` | What it catches |
| --- | --- | --- |
| `unreachable_floor` | certain | The profile's minimum custom format score is higher than every positive score in it adds up to. Nothing can satisfy it. |
| `knife_edge_floor` | certain | The minimum is exactly that total. Every positive format must match, and one negative match rejects the release. |
| `subset_format_scored` | certain | A scored format matches a strict subset of the languages an unscored one does — the wider format would have scored and does not. |
| `language_preferred_not_required` | likely | A language format is scored, but the other formats reach the minimum without it (or there is no minimum), so a release in any language still passes. |
| `dialect_sibling_missing` | likely | A required format covers one half of a dialect pair (Dutch/Flemish, Portuguese/Brazilian, Spanish/Latino) but not the other, rejecting that half outright. |
| `profilarr_drift` | certain | Profilarr's saved profiles have drifted from what this Radarr/Sonarr instance currently holds. |

`certain` is arithmetic: the three findings above it follow from the scores
alone, with no false positives possible. `likely` is a heuristic — a narrow
one, checked against a live stack, but a judgement rather than a proof.

`profilarr_drift` is instance-scoped rather than tied to any one profile, so
it is unaffected by the `profile` filter and carries no `profile` field.
`drift: null` on the Profilarr side means "not checked yet"; it is never
folded into a finding, and its presence is instead surfaced through `note` so
an absence of drift findings is not misread as a clean bill of health.

Needs at least one of Radarr, Sonarr or Whisparr configured to find anything.
Drift findings additionally need a `profilarr` service — without one, `note`
says so and the rest of the findings still run.

## `sync_database`

The only write on Profilarr, and it reaches Profilarr alone — never Radarr or
Sonarr. Asks Profilarr to pull one of its databases (custom formats, quality
profiles, delay profiles) from its configured git source. `database` names
one by name or id; required only when Profilarr has more than one.

Safe tier: it changes only Profilarr's own store. The arrs pick up whatever
changed only when Profilarr syncs them on its own schedule, same as any other
Profilarr-triggered sync.

Profilarr answers the trigger with a 202 and a job id, not an outcome, so
`apply` polls `GET /jobs/{id}` to a terminal status before reporting anything
— a queued-but-not-finished sync is never reported as done. Not reversible
through arr-mcp; revert in Profilarr or git if the pulled change is unwanted.

A finished job can still have done nothing: Profilarr reports the queue
outcome and the handler's own outcome separately, and the latter can be
`skipped` — nothing to pull — even though the queue says `success`. That
shows up as `outcome: "skipped"` in the structured result, and the reply text
says plainly that nothing was pulled rather than reporting a completed sync.

## `pause_downloads`

The bandwidth answer: "stop downloading for an hour". Pauses or resumes one
download client — SABnzbd, NZBGet, Transmission or qBittorrent — or one item in its
queue when `id` is given.

`action: "limit"` throttles instead of stopping: `speed_limit_kbps` is the cap
in KB/s, and `0` removes it. Always client-wide, never per item.

Each client speaks a different unit, and the wrong one throttles a stack to
nothing — SABnzbd reads a bare number as a *percentage* of the configured line
speed, qBittorrent wants bytes per second, Transmission wants KB/s behind an
enable flag it keeps separately, and NZBGet's `rate` takes KB/s while its
`status` reports the limit in bytes per second. The tool boundary is KB/s and each adapter
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
SABnzbd and NZBGet publish a client-wide paused flag; for the two torrent clients
"paused" means every torrent is stopped, and a client holding no torrents at
all reads as *not* paused — nothing to pause is a different state from
everything paused, and treating them alike would refuse a legitimate call.

The qBittorrent path is **spec-derived and unverified against a live
instance**: there is no qBittorrent on the stack these adapters were probed
against. v5 renamed `pause`/`resume` to `stop`/`start`, so both verbs are
attempted — the new one first, the old one only if it 404s.

## `retry_download`

"This download failed, try it again", on the usenet client that holds the files,
SABnzbd or NZBGet, or on Shelfmark. `id` is the one on that client's `get_history`
or `get_queue` row. The preview picks what to send from the job itself and shows it:

- **Shelfmark:** a failed or cancelled book goes back to the front of its queue,
  under the same id, if Shelfmark marks the row as retryable. `password` is refused.
- **SABnzbd, failed job in history:** retried with `mode=retry`. SABnzbd gives the
  retried job a **new id**, and the result says so (`previous_id`), so take the
  new one from there.
- **SABnzbd, paused encrypted job in the queue:** `password` is set and the job
  resumes. It is found by SABnzbd's ENCRYPTED label, which SABnzbd translates,
  so it is not recognised on a non-English UI.
- **NZBGet:** `password`, if given, is stored in the job's `*Unpack:Password`
  parameter. A job with missing articles then has them fetched again
  (`HistoryRetryFailed`); one that has every article but failed to unpack (a
  missing password, a full disk) or was left repairable by the par check has
  post-processing run again (`HistoryProcess`).

Give `password` when the failure was an encrypted archive; it comes from the site
the NZB came from. It is never shown back, and the audit log redacts it. When a
SABnzbd job was added from a URL, a retry fetches the NZB again and may not keep
the password; the preview says so.

**Moved on.** The preview checks whether Radarr or Sonarr has already grabbed a
replacement for the same media and whether it was imported. If so it warns that
retrying may leave two copies, and does not refuse. Whisparr and Lidarr are not
checked; when one is configured, the preview says that too. A Radarr or Sonarr that
cannot be reached is named rather than treated as "no replacement".

**After the retry.** The result says which *arr is tracking the download (or that
none recorded it), and repeats the two-copies warning when the preview found a
replacement.

**Remove Failed must be off.** Radarr and Sonarr's "Remove Failed" setting
(Settings, Download Clients, on by default) deletes a failed job from the client
as soon as it fails, so there is nothing left to retry. Their grabs are only
retryable with it off.

If no *arr imports the result, `trigger_scan` with `action: "import"` does; the
result names the `download_id` to give it (the new nzo_id after a SABnzbd retry,
the `drone` id for an NZBGet download an *arr grabbed). The hint is left out
when the retry failed again or the job is already gone from the client. Safe
tier; see [writes.md](writes.md).

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

Lidarr does the same for an album whose artist was deleted, and `clean_queue`
takes `service: "lidarr"` with the same rule, **from Lidarr 2.10.1**. That is
the first release whose `CompletedDownloadService` marks such a download
`importBlocked`; before it, the download stays `status: "completed"` with
`importState: "downloading"` and a warning ("Artist name mismatch, automatic
import is not possible"), so on 2.1.3 to 2.10.0 the rule matches nothing, and a
Lidarr preview with nothing to clean says so. Remove one of those with
`remove_queue_item`. A deleted artist's downloads that had already imported read
`orphaned` with `importState: "imported"` instead, and are left alone: they are
not stuck, and `remove_queue_item` removes one if it is wanted gone.

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

Six actions, one idea: make a service reconcile itself with what is on disk
and, on the *arrs, with its metadata provider.

| Call | What it does |
| --- | --- |
| `service` alone | Scans that service's whole library, refreshing metadata first on the *arrs. On Prowlarr, which has no library, it syncs the indexer list to Radarr and Sonarr instead. |
| `service` + `id` | Refreshes and rescans just that Radarr/Sonarr/Whisparr item — far cheaper on a large library. On Lidarr it refreshes one artist, but the rescan after it still reads every root folder. |
| `action: "rename"` + `id` | Renames that item's files to the service's own naming scheme. |
| `action: "import"` + `download_id` | Imports a finished download the service never picked up. |
| `action: "remap"` + `id` + `reassignments` | Tells Sonarr which episode an already-imported file really is, and renames those files to match. |
| `action: "postprocess"` + `download_id` | Reruns NZBGet's post-processing on a finished download that is still in its history. |
| `action: "bookdrop"` | Has Grimmory look in its Bookdrop folder again. With `action: "scan"`, `library` rescans one Grimmory library. See [On Grimmory](#on-grimmory). |

Everything here queues a command and returns, except `remap` and `postprocess` — see below.
`stack_health`'s `commands` list says whether it has finished; do not assume it
has. Whisparr's commands are not reported there.

### What a scan does on each service

On Radarr, Sonarr, Whisparr and Lidarr a scan is the service's refresh command:
`RefreshMovie`, `RefreshSeries` or `RefreshArtist`. It re-reads titles and air
dates from the metadata provider, then rescans the folders unless the service's
"rescan after refresh" setting is Never. With `id` on Sonarr this is the same
command as the series page's Refresh & Scan button.

That makes it the fix for an import refused over metadata the service has not
caught up with, such as Sonarr's "Episode has a TBA title and recently aired".
The flow is `trigger_scan` with the series `id`, then `stack_health` until
`commands` shows the refresh finished, then `import` again. A refresh only helps
once the provider has the title.

On Jellyfin and Plex a scan looks for files that changed. It does not re-match
what is already there, which is what `fix_metadata` is for.

### On Lidarr

A scan is Lidarr's `RefreshArtist`, for the whole library or with `id` for one
artist. The rescan after it is Lidarr's `RescanFolders`, the scan time
`stack_health` reports under `scans`. With `id` only the refresh narrows: the
rescan still reads every root folder unless the artist is new
(`RefreshArtistService.RescanArtists`), so it reads the whole library from disk,
as a full scan does. `rename` is `RenameArtist`, every file of that artist. Both
appear in `stack_health`'s `commands`.

`import` reads Lidarr's queue first and refuses a download that has not
finished. Lidarr's candidate read for one fails, as Radarr's and Sonarr's does,
when it comes from NZBGet, but from a torrent client it lists the partial files
and judges them as they stand. It then reads the candidates with
`replaceExistingFiles=false`, because Lidarr's own default for that read is
true: it would judge every file as if it may overwrite the library's copy. Each
file is named in the preview by artist and album. A file Lidarr matched to no
album, no release or no tracks is not importable, the way a Sonarr file with no
episode is not: `ManualImport` looks up the album, the release and the tracks by
id for every file. `mapping` is refused on Lidarr rather than ignored, since it
names movies and episodes, and a Lidarr file belongs to an album and its tracks.
A wrong album match is fixed in Lidarr itself.

There is no Lidarr `remap`.

### On Plex

Plex has no scan-the-whole-server call, so a scan refreshes every library in
turn. If one of them refuses — a library removed between the listing and the
refresh — the rest still start and the answer names the ones that did not, so
you know a scan is running and which shelf it missed. All of them refusing is
an error, because then nothing is.

Plex returns no command id, so there is nothing in `commands` to poll. It
reports the scan through each library's own `refreshing` flag instead, which is
what `stack_health` and `diagnose` already read.

### On Grimmory

Grimmory takes two actions.

- `action: "scan"` rescans every library, or one with `library`, by name or by
  id as `stack_health` and `get_library` show it. A name is matched ignoring
  case. If a name and an id pick different libraries the call is refused and the
  refusal lists them. So is a name that matches two libraries differing only in
  case. A library that does not exist is refused, listing the ones
  that do.
- `action: "bookdrop"` has Grimmory look in its Bookdrop folder again for new
  files. It imports nothing: the files wait there until someone finalises them
  in Grimmory, and `get_queue` lists them. Pass no `library` with it.

A library with `watch` on is skipped, since Grimmory's file watcher already picks
up changes there. The preview names each library it will rescan and each one it
skips, and a call that would rescan nothing is a no-op. Libraries are rescanned
one after another, in the background. `id` is refused, because a book cannot be
scanned on its own, and `library` and `bookdrop` are refused on any other
service.

Safe tier. A non-admin account needs `canManageLibrary` for a library and
`canAccessBookdrop` for the Bookdrop.

### Importing a download that never landed

`diagnose` can tell you the import is the problem, and a library scan does not
fix it: the file is still sitting in the download client's folder, and the *arr
never took it. `get_queue` shows exactly this as a row stuck at
`importState: "importBlocked"`.

The flow is `get_queue` → take that row's `downloadId` → `trigger_scan` with
`action: "import"`.

The preview lists, file by file, what will be imported and what the service
refuses and why. Rejected files are **excluded** from the import rather than
forced through: this imports what the service is willing to take.

#### When the service cannot tell what a file is

A title mismatch, an unknown movie or an unplaceable episode fails the same way
on every retry; `get_queue`'s `statusMessages` say which. `mapping` gives the
answer the web UI's Manual Import dialog would: per file, `movie_id` on Radarr,
or `series_id`, `season` and `episodes` on Sonarr.

```json
{ "service": "sonarr", "action": "import", "download_id": "SABnzbd_nzo_ab12",
  "mapping": [{ "path": "Show.S02E03E04.mkv", "series_id": "7", "season": 2, "episodes": [3, 4] }] }
```

Each mapped file goes back through the service's own reprocess call, the one
that dialog makes, and is imported only if the service then accepts it. A
mapping answers "which movie is this"; it does not override a rejection the
service still has, like a sample or a file that is not an upgrade. Files the
mapping leaves out keep the service's own match. The confirm token binds to
the mapping, so a token from one mapping does not apply another.

Outcomes that look alike and are not:

- **Nothing to import** — the service sees no files for that download id. A
  no-op, with no confirmation asked for.
- **Everything rejected** — there are files and it will take none of them. A
  refusal naming the reasons. Reporting that as "nothing to do" would read as
  "it was already imported", which is the opposite of what happened.
- **Still downloading** — the download is `queued`, `paused`, `delay` or
  `downloading`, so there is nothing to import yet. Radarr and Sonarr answer
  this with an HTTP 500 from a null dereference of their own rather than a clean
  refusal, so the message names the state `get_queue` reports instead of passing
  that on as a service fault; Lidarr's queue is checked before its read, since
  it would list a torrent's partial files instead.
- **Failed** — the download is `failed` in the client, so it is not going to
  finish. Named as failed, with `remove_queue_item` as the remedy.
- **Warning** — the download is `warning` in the client, which usually means
  stuck rather than stopped: a stalled torrent or missing files. A stalled
  torrent often finishes later, though not every warning will (a qBittorrent
  magnet with DHT off waits there for good), so it is named as a warning and the
  remedy points at the row's `errorMessage`, the client's own reason, and any
  `statusMessages`, in `get_queue` at `detail: "full"` (`standard` leaves
  `errorMessage` out).
- **Anything else** that is not `completed` (`unknown`,
  `downloadClientUnavailable`, `fallback`) is reported only as not completed,
  with no claim about what the client is doing.

The import re-reads the candidates when it runs rather than trusting the
preview's list, so a download whose files have changed in between imports what
is there now or fails — never a path that no longer exists.

### Running NZBGet's post-processing again

When a post-processing script is wrong, every download it touched is stuck: an
unpack that never happened leaves Radarr or Sonarr with "No files found are
eligible for import" on each one, and fixing the script does nothing for the
downloads it already handled. `action: "postprocess"` is NZBGet's "post-process
again" for one of them.

The flow is `get_queue` → the stuck row's `downloadId` → `trigger_scan` with
`service: "nzbget"` and `action: "postprocess"`. NZBGet's own rows in
`get_history` carry the same `downloadId`. The id is the `drone` parameter an
*arr stamps on the NZB it sends; for an NZB added by hand it is NZBGet's own
id.

The preview names the download, the folder post-processing runs in (NZBGet's
`DestDir`, plus where the files were moved afterwards when that differs) and the
post-processing scripts enabled for it, because those scripts are what runs.
The confirmation binds to that exact history item: if the same id names a
different one by the time it is confirmed, for example because the release was
grabbed again, the token is rejected and nothing runs. A download already in
NZBGet's queue is refused, so a rerun never starts on top of another.

Once confirmed, NZBGet repeats repair and unpack as it is configured, then those
scripts. Radarr, Sonarr or Lidarr still imports the result: on its next queue
check, or straight away with `action: "import"`.

It only works while the download's folder still exists. When the folder has
been moved or deleted, NZBGet still answers the request with success and logs
`Could not post-process again <name>: destination directory … doesn't exist`
instead. So the answer alone proves nothing. This watches, for a few seconds,
for one of four things:

- the download in NZBGet's queue: the rerun is still going, and `get_queue`
  shows it until it finishes;
- the download back in history after this rerun: the rerun finished, and the
  answer gives the status it finished on, saying so plainly when it failed
  again;
- the download gone from both after NZBGet showed this rerun running or filed
  it: a quick rerun whose result an *arr already imported and removed from
  NZBGet's history, which the answer says so the *arr is checked instead;
- the logged refusal for exactly this download: an error naming the missing
  folder.

If none of them happens, it reports an error rather than success.

### Putting a mislabeled file on the right episode

Some files were mislabeled at the original import: the file named `S01E24` is
really the Pilot. The filename, Sonarr's database, the media server and Sonarr's
own matcher all agree with the wrong answer, so `get_metadata_issues` finds
nothing. `remap` applies a correction a person has already made, usually by
watching the file.

```json
{
  "service": "sonarr",
  "action": "remap",
  "id": "5",
  "reassignments": [
    { "path": "Season 01/Show - S01E24.mkv", "season": 1, "episode": 1 },
    { "path": "Season 01/Show - S01E01.mkv", "season": 1, "episode": 2 }
  ]
}
```

`path` is relative to the series folder, as Sonarr names it, or absolute. Only
files Sonarr has already imported can be reassigned.

The preview lists each file's current and new episode. Files already on the
episode asked for are left out. The call is refused if it would leave a file
attached to no episode: moving a file onto an episode that already has one
means the list must also say where that one goes. Send the whole rotation in one
call, because a half-applied one reads as a missing episode plus a dangling file.

Nothing moves on disk. What changes, and what Sonarr does not report itself:

- Each moved file gets a new episode file id, so an id read before the remap is
  stale, including for `delete_episode_files`.
- The moved files' date added resets to now, which reorders "recently added" in
  Sonarr and in the media server.
- Sonarr writes nothing to its history. The audit log here is the only record.

**The rename is part of it.** Once the reassignment lands, the moved files are
renamed to match the episodes they are now on — only those files, not the rest
of the series, which is what `action: "rename"` would do. That is the one call
here that does not return while its work is still queued: the rename needs the
file ids the reassignment assigns, so it waits.

Rescan your media server afterwards, so it reads the corrected library.

**A rotation is renamed in two passes, and that costs a setting for a moment.**
When files are rotated among episodes that already hold one — the whole-season
case above — every name a file wants is the name another file in the set is
still using, so no rename has a free destination. Sonarr reports that as
`completed` having renamed nothing, which is why the count is read rather than
the status.

There is no "rename this file to that name" in Sonarr's API: `RenameFiles`
renames to whatever the naming format produces. So a rotation is renamed by
**changing the episode naming format for that series type, server-wide, for the
length of two rename commands** — once into names nothing holds, then back, then
into the real ones. The preview says so before you confirm.

Five things bound it:

- **It will not start behind a queue.** Anything running or queued beyond
  Sonarr's own per-minute housekeeping and the remap refuses the rename,
  because the window is one command's turn in the queue and that can be
  minutes. The reassignment is already applied at that point, so the refusal
  says so: run the remap again when Sonarr is quiet.
- **It survives being killed.** The temporary format is the real one plus a
  marker on the end, so the next run recovers the original by removing it. No
  copy is written anywhere to be lost.
- **It reports what the window caught.** Sonarr's own import runs every minute
  and is not waited for, so a file that lands inside the window is named by the
  temporary format. The response names those files: the imports Sonarr recorded
  after the window opened whose name carries the marker.
- **It checks the second pass finished.** A file left under a temporary name is
  the worst outcome here, so that is an error naming the marker, not a success.
  Sonarr's own list of files still wanting a different name decides it, not
  the command's count.
- **It puts back only what it changed.** The format is restored by re-reading
  the config and setting that one key, so anything else edited during the
  window stays edited.

A remap whose files each have a free destination never touches the naming
format. The preview cannot always tell which case it is: what Sonarr will name
a file is known only once the reassignment is applied, so it says when the
format would change rather than promising it will not.

## `delete_media`

Removes a film from Radarr, a series or site from Sonarr or Whisparr, or a book
from Grimmory. It takes `service` and `id`, never a title, with `id` from
`acquisition.id` on a `get_library` or `get_media_details` record. `destructive`
tier, and the preview comes first.

### Grimmory

`service: "grimmory"` deletes a book. `id` is the book id, as `58` or
`grimmory:58`. Grimmory deletes a book's files with it and has no keep-files
option, so `delete_files: true` is required and a call without it is refused.
`add_import_exclusion` is refused too, since Grimmory has no exclusions.

The preview reads the book first, so a wrong id fails with a clear error. It
names the book, the size and formats of the files it will delete from disk, and
says the book goes from Grimmory with its metadata, shelves and reading progress.
There is no undo. If Grimmory removes the book but cannot delete a file, the
answer says the book is gone and the files are still in the library folder.

A non-admin account needs `canDeleteBook`.

## `update_media`

`add_media`'s counterpart: it changes what something already in Radarr, Sonarr
or Lidarr is set to — `quality_profile`, `root_folder`, `monitored`, `tags`,
Radarr's `minimum_availability`, Sonarr's `series_type`, Lidarr's
`metadata_profile`.

It is also **the only way to change a Radarr item's monitoring**.
`set_monitoring` covers series and artists, and has never covered films.

On **Lidarr**, `id` is an artist, and `metadata_profile` switches Lidarr's
second profile, which decides the album types and release statuses the artist
gets. It writes through Lidarr's Artist Editor (`PUT /artist/editor`), as
`set_monitoring` writes an artist's policy, because `PUT /artist/{id}` queues a
`MoveArtist` on every call. The editor starts no refresh, so a new metadata
profile applies at the artist's next one. That refresh removes the albums the
new profile leaves out unless they have files or were added by hand (under
`None`, every such album), and switching back later brings them in again as new
albums, without their old flags. The albums it brings in are flagged by the
artist's `monitor_new_items` rule, and Lidarr then searches the released ones
while the artist is monitored (in Lidarr newer than 3.2.0.5144, only those
released in the last 180 days). It searches at the rescan after that refresh, or
at the next disk scan when Lidarr's "Rescan Artist Folder after Refresh" setting
skips that rescan. The preview says all of this. An unknown name is refused,
listing the instance's metadata profiles.

`monitored` is the artist's own flag: the albums keep theirs, which
`set_monitoring` with `level: "album"` changes, and the rule for new albums,
`monitor_new_items`, is `set_monitoring`'s too.

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
nothing: the undo is moving it back. A Lidarr metadata profile is the one
exception: once a refresh has removed albums, switching back brings them in
without their old flags, which the preview says. A request that would change
nothing is a no-op, and a request naming no field at all is refused rather than
previewed.

### Grimmory

`service: "grimmory"` edits a book by hand, with `id` from `acquisition.id` on a
`get_library` book row. It takes these fields:

| Parameter | Sets |
| --- | --- |
| `title` | The title |
| `authors` | The authors; the list replaces the old one |
| `series` | The series name; `""` clears it |
| `series_number` | The book's number in its series, above zero |
| `tags` | The book's categories, as free text that need not exist yet; the list replaces the old one, and `[]` clears it |
| `lock_fields` | Fields to lock after writing, so a metadata refresh leaves them alone |
| `unlock_fields` | Fields to unlock before writing |

`lock_fields` and `unlock_fields` take `title`, `authors`, `series`,
`series_number` and `tags`. Only the fields named are sent. A blank title, author,
tag or series is refused, and a series is cleared with `""` and the categories
with `[]`. Naming no field is refused. `quality_profile`, `root_folder`,
`monitored`, `minimum_availability`, `series_type` and `metadata_profile` are
refused for a book, and the book fields are refused for a film, series or artist.

A locked field is refused unless the same call unlocks it. A book with every
field locked is refused, with the advice to unlock it in Grimmory, since
`unlock_fields` releases single fields. Locking and unlocking one field in the
same call is refused. The preview lists each field, old value to new, says what it
unlocks first and what it locks afterwards, and calls a request that changes
nothing a no-op.

Grimmory may write the change into the book file and move it to match its naming
pattern, when its metadata settings say so, and the preview says that. Safe tier.
A non-admin account needs `canEditMetadata`.

## Prompts and resources

Forty tools do not tell you which one to reach for, and the questions
people actually ask are rarely one call.

**Five prompts**, which most clients surface as slash commands:

| Prompt | Asks |
| --- | --- |
| `why_not_playable` | Why isn't this playable? |
| `whats_wrong` | What needs my attention right now? |
| `what_to_watch` | What should I watch tonight? |
| `best_in_library` | What's the best thing I own? |
| `whats_new` | What happened this week? |

**Four data resources**, which a client can attach once rather than re-fetch, and field references for the longer tools:

| Resource | Holds |
| --- | --- |
| `arr://instances` | Every instance id and what it may do — the values other tools accept as `instance` |
| `arr://health` | A stack verdict, stamped with when it was taken |
| `arr://library/summary` | Total, on disk, still wanted |
| `arr://lidarr/monitoring` | Every Lidarr artist's monitoring policy: who will keep discovering albums, and who carries the artist flag; with more than one Lidarr, each instance that answered as well (one that did not is in `degraded`), and totals that add them up (an artist two hold counts in each) |
| `arr://docs/<tool>` | The full field reference for the tools with the most to explain (`get_library`, `stack_health`, `get_queue` and fourteen more). Each of their descriptions is kept under 1,000 characters and ends with a pointer here |

**Client support for both is uneven, so nothing is reachable only through
them.** A prompt is a sequence of tool calls the model could have made anyway,
and every resource mirrors something a tool already returns; a field reference
explains fields the tool results already carry. On a client that
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
