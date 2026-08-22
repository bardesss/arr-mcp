# The IMDb dataset

> **If you want IMDb scores for TV series, you need this. There is no other way
> to get them.** Nothing else in this stack has that number — not Sonarr, not
> Seerr, not Jellyfin. Leave the dataset off and `rating_source: imdb` on a
> series matches nothing, which reads as "your shows are unrated" rather than
> "this server cannot look that up". Films are unaffected.

## Why the gap exists

Ratings across this stack are inconsistent, and for series they are absent.

Radarr returns a per-source map, so a film can carry IMDb, TMDB, Rotten Tomatoes
and Metacritic scores at once. Sonarr returns a single unlabelled number, which
arr-mcp can only honestly record as TVDB's. Seerr's `/tv/{id}/ratings` is Rotten
Tomatoes only — the combined endpoint that carries the IMDb half exists for
films alone, upstream.

So **no service here can tell you a series' IMDb rating**, and asking
`get_library` for one used to be refused outright.

## Switching it on

```yaml
metadata:
  imdb:
    enabled: true
```

Or tick **IMDb dataset** in the config UI, which applies immediately — the
download starts when you save, with no restart.

No account, no API key, nothing sent anywhere. Your container downloads two of
IMDb's published files and keeps them in a local SQLite database beside the
audit log. The first ingest takes a few minutes; every tool answers exactly as
it did before until it lands, and the dashboard says when it has finished.

The ingest runs in its own thread and writes to its own connection, so the
server keeps answering throughout — reads see the previous dataset until the
new one is committed, whole. That holds for the weekly refresh as much as the
first one.

## What it costs

Measured against the live dumps on 2026-08-10:

| | |
| --- | --- |
| Download, per refresh | **223 MB** |
| Refreshed | **weekly** |
| On disk | **~81 MB** |
| First ingest | ~3 minutes |
| Titles stored / rated | 809K / 809K |

Only rated titles of a kind something can actually reach are stored — the other
12 million rows are episodes and video games no query can touch. The two tables
hold the same set of ids: a rating is kept exactly when its title is, which is
what took `rating` from 1.7M rows to 809K.

The on-disk figure is what a running server actually leaves behind. It used to
be ~125 MB, and three changes account for the difference — both tables are
`WITHOUT ROWID` (each keyed on `tconst` alone, so the old layout stored every id
twice), ratings with no stored title are pruned, and the database is vacuumed
after each replace so freed pages go back to the OS rather than leaving the file
at its high-water mark for ever. That last one is also why the number is now
honest: the old ~125 MB was measured post-`VACUUM` by the script, and no live
install ever reached it.

Re-measure with `node --experimental-strip-types scripts/measure-imdb.ts`; the
dumps grow, and a figure in a README is only as good as the day it was taken.

## Weekly, though IMDb publishes daily

What this holds is average ratings for titles that already exist, and an average
over millions of votes moves by hundredths across a year — a nightly
re-download spent 6.5 GB a month to answer every question exactly as it did the
night before.

The cost is that a title published in the last week may not be there yet, so a
brand-new release can be missing from `discover_media` and a series added the
day it premiered goes without an IMDb rating until the next refresh.

The interval is not configurable.

## Do you need it?

**For everything except a series' IMDb rating, this is a fallback.** Seerr
already supplies ratings for both films and series, and it needs no disk at all:

| | Films | Series |
| --- | --- | --- |
| **In your library** | Radarr: IMDb, TMDB, Rotten Tomatoes, Metacritic | Sonarr: one unlabelled number |
| **Not in your library** | Seerr: TMDB, Rotten Tomatoes, IMDb | Seerr: TMDB, Rotten Tomatoes |

Read the bottom-right cell: **no IMDb, either column, for a series.** That gap
is the one thing the dataset uniquely fills.

So switch it on if:

- **you want an IMDb number for a series** — the dataset is the only source, in
  your library or out of it; or
- **you do not run Seerr**, or want ratings to survive Seerr being down.

The second is a footnote, not a feature. If TMDB and Rotten Tomatoes are enough
for your series, you do not need this — but if you came here for IMDb scores on
TV, the first reason is the whole answer.

```
get_library({ kind: "series", watched: false, rating_source: "imdb",
              sort: "rating", limit: 10 })
```

> The ten best-rated series you have not watched.

## Two honest limits

The dataset keys on IMDb ids, and Radarr leads with TMDB ids, so titles carrying
no IMDb id are never matched — they come back unrated, and counted.

And the first ingest takes a while on a NAS. Everything answers exactly as it
did before until it lands, and the dashboard says when it has finished.

`discover_media` also falls back to the dataset when Seerr is not configured,
where it previously returned nothing. Seerr still answers whenever it is
present — it knows what is trending and requestable, which a static catalogue
does not.

## Licence

Those datasets are published for **personal and non-commercial use**.

> Information courtesy of
> [IMDb](https://www.imdb.com) ([datasets](https://developer.imdb.com/non-commercial-datasets/)).
> Used with permission.

arr-mcp never redistributes them and ships no prebuilt copy — your own container
downloads them, for your own use, only if you switch the dataset on. It is off
by default.
