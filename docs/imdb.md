# The IMDb dataset

> **If you want IMDb scores for TV series, you need this. There is no other way
> to get them.** Nothing else in this stack has that number: not Sonarr, not
> Seerr, not Jellyfin. Leave the dataset off and `rating_source: imdb` on a
> series matches nothing, which reads as "your shows are unrated" rather than
> "this server cannot look that up". Films are unaffected.

## Why the gap exists

Ratings across this stack are inconsistent, and for series they are absent.

Radarr returns a per-source map, so a film can carry IMDb, TMDB, Rotten Tomatoes
and Metacritic scores at once. Sonarr returns a single unlabelled number, which
arr-mcp can only honestly record as TVDB's. Seerr's `/tv/{id}/ratings` is Rotten
Tomatoes only; the combined endpoint that carries the IMDb half exists for
films alone.

So **no service here can tell you a series' IMDb rating**.

## Switching it on

```yaml
metadata:
  imdb:
    enabled: true
```

Or tick **IMDb dataset** in the config UI, which applies immediately: the
download starts when you save if the dataset is empty or more than a week
old, with no restart. Switching the dataset off and on again with a current
`imdb.db` on disk downloads nothing.

No account, no API key, nothing sent anywhere. Your container downloads two of
IMDb's published files and keeps them in a local SQLite database beside the
audit log. The first ingest takes a few minutes; every tool answers exactly as
it did before until it lands, and the dashboard says when it has finished.

The ingest runs in its own thread, so the server keeps answering throughout:
reads see the previous dataset until the new one is committed whole, on the
first ingest and every weekly refresh.

## What it costs

Measured against the live dumps on 2026-08-23:

| | |
| --- | --- |
| Download, per refresh | **224 MB** |
| Refreshed | **weekly** |
| On disk | **~81 MB** |
| Peak ingest memory | **~650 MB** |
| First ingest | ~2 minutes |
| Titles stored / rated | 811K / 811K |

Only rated titles of a kind a query can reach are stored; the other 12 million
rows are episodes and video games. The peak memory comes from holding IMDb's
~1.7M ratings during ingest, in the worker thread, and is released when the
ingest finishes. The database is vacuumed after each replace, so the on-disk
figure is what a running server leaves behind.

Re-measure with `node --experimental-strip-types scripts/measure-imdb.ts`; the
dumps grow.

## Weekly, though IMDb publishes daily

What this holds is average ratings for titles that already exist, and an average
over millions of votes moves by hundredths across a year: a nightly
download would cost 6.5 GB a month for no change in answers.

The cost is that a title published in the last week may not be there yet, so a
brand-new release can be missing from `discover_media` and a series added the
day it premiered goes without an IMDb rating until the next refresh.

A restart does not re-download. The next refresh is a week after the last
ingest, and runs at once on start only when the dataset is empty or older than
a week.

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

- **you want an IMDb number for a series**: the dataset is the only source, in
  your library or out of it; or
- **you do not run Seerr**, or want ratings to survive Seerr being down.

If TMDB and Rotten Tomatoes are enough for your series, you do not need this.

```
get_library({ kind: "series", watched: false, rating_source: "imdb",
              sort: "rating", limit: 10 })
```

> The ten best-rated series you have not watched.

## Two limits

The dataset keys on IMDb ids, and Radarr leads with TMDB ids, so titles carrying
no IMDb id are never matched: they come back unrated, and counted.

And the first ingest takes a while on a NAS (see above).

`discover_media` also falls back to the dataset when Seerr is not configured.
Seerr still answers whenever it is present, since it knows what is trending and requestable.

## Licence

Those datasets are published for **personal and non-commercial use**.

> Information courtesy of
> [IMDb](https://www.imdb.com) ([datasets](https://developer.imdb.com/non-commercial-datasets/)).
> Used with permission.

arr-mcp never redistributes them and ships no prebuilt copy: your own container
downloads them, for your own use, only if you switch the dataset on. It is off
by default.
