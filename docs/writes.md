# Writes

Nothing writes to your stack until you say so, per service. Every write is
previewed before it acts and recorded either way — this is how each of those
guarantees actually behaves.

## Permissions

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
write access by doing so.

The tiers are ordered: `destructive: true` implies `safe_write`, so you never
have to reason about a config that permits deleting a film but refuses to
re-monitor it.

**Permissions are per instance.** `safe_write` on `radarr/hd` and nothing on
`radarr/4k` is a configuration you can express — each entry carries its own
`permissions` block.

| Tool | Tier | Needs |
| --- | --- | --- |
| `trigger_search` | safe | `safe_write` |
| `trigger_scan` | safe | `safe_write` |
| `trigger_subtitle_search` | safe | `safe_write` |
| `respond_to_request` | safe | `safe_write` |
| `add_media` | safe | `safe_write` |
| `set_monitoring` | safe | `safe_write` |
| `remove_queue_item` | destructive | `destructive` |
| `delete_media` | destructive | `destructive` |
| `delete_episode_files` | destructive | `destructive` |
| `delete_request` | destructive | `destructive` |

### Where the tier boundary falls

Approving and declining a request are one tool and deleting one is another,
because that is where the boundary is: a verdict can be reversed, a deleted
record cannot. `delete_request` removes the *request*, never the media —
anything already downloaded stays on disk, and the preview says so before you
confirm rather than after.

`remove_queue_item` is destructive rather than safe because it deletes partial
data, and because `blocklist: true` durably teaches Radarr or Sonarr to refuse a
release — which is hard to notice and hard to undo months later, when the same
film mysteriously never grabs. SABnzbd and Transmission have no blocklist of
their own; ask for one there and the preview tells you it is being ignored
rather than silently accepting a flag that does nothing.

## The confirmation handshake

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

## `dry_run`

The separate, terminal form: it describes the effect and issues no token at all,
so it can never turn into a write. It works even with the tier switched off, and
tells you which key you would need to set.

That is how you answer *"what would this do?"* without granting anything first.

## Below the level of a whole item

`set_monitoring` (safe — nothing is deleted and Sonarr can undo it) turns
monitoring on or off for a whole series, one season, or specific episodes: give
`season` or `episodes`, never both, and giving neither targets the whole series.

`delete_episode_files` (destructive) deletes the files for one season or
specific episodes. There is no whole-series form, because that is what
`delete_media` already does.

### Unmonitor before you delete

If a season's or episode's files are deleted while it is still monitored, Sonarr
treats them as missing and re-downloads exactly what you just deleted. That is
the reason these shipped as two separate tools rather than one that does both.

`delete_episode_files`'s preview warns when the target is still monitored, and
says nothing when it is not, so the warning is worth reading rather than
skipping past. It reads the episodes' own monitored flags, not Sonarr's
per-season summary of them, which `set_monitoring`'s episode form can leave
behind.

On a series long enough that the episode list is truncated, the preview says the
monitoring state could not be established rather than staying quiet — silence
there would read as "nothing is monitored".

### Both tools refuse rather than write into the dark

Given an episode id it cannot resolve — wrong, or past the 500-episode cap —
either tool refuses outright rather than silently dropping it. `set_monitoring`
refuses a season the series does not have, naming the seasons it does.

A write that matches nothing would otherwise report success, and you would go on
to delete files believing the season was unmonitored.

When a file holds more than one episode, which Sonarr routinely does for a
double episode, `delete_episode_files` names every episode the delete would take
with it, not just the one you asked for.

Episode ids for both tools come from `get_media_details`, whose `episodes` also
carry `episodeFileId` — the file each episode is on, when it has one — which is
how `delete_episode_files` resolves a target without a second read.

## The audit trail

Every attempt — applied, previewed, refused, dry run, or failed mid-flight — is
recorded in `config/audit.db` beside your `config.yaml`, with the resolved
target and the arguments.

If that file cannot be written, writes are refused rather than proceeding
unrecorded. Reads are unaffected.

The config UI's **Write audit** page reads the same trail.

## Ids, never titles

Write tools take `service` and `id`. Titles are resolved fuzzily, which is fine
when the cost of being wrong is a wrong answer and not fine when it is an action
against the wrong film — use `get_media_details` or `get_library` to get an id
first.

`add_media` takes an external id instead: TMDB for Radarr, TVDB for Sonarr, both
returned by `lookup_media` under `ids`.

### `add_media` needs a quality profile and a root folder

If your service has exactly one of each, it uses them without asking. If it has
several and you name none, **it refuses and lists them** rather than picking:

> radarr has several quality profiles and none was named — Name one —
> available: Any (id 1); HD-1080p (id 4); HD-2160p (id 5); … Not guessing,
> because the wrong one is not obvious until the download finishes.

### With more than one instance, writes name one

Adding a film with two Radarrs configured and no `instance` is refused, and the
refusal lists the names rather than guessing — a 4K release landing in the HD
instance is only discovered once the download has finished.

```
add_media { service: "radarr", external_id: "550" }
```

> radarr has 2 instances configured, so "radarr" alone does not say which —
> pass `instance` with one of: "4k", "hd".

That means **adding a second instance changes how existing prompts behave**:
requests that used to be unambiguous start asking which instance you meant. That
is deliberate, and it only affects writes.

## Managing someone else's request

`respond_to_request` and `delete_request` act on a Seerr request that belongs to
somebody. If that somebody is not the configured `default_user`, the write is
refused unless `services.seerr.allow_other_users` is `true`:

> request 31 belongs to another user — set `services.seerr.allow_other_users:
> true` to manage requests other people made.

This is the same gate `get_requests` applies to reading them. Without it, the
read side would refuse to so much as list a request that the write side would
approve — and name the title and requester while previewing it. Request ids are
small integers, so anything the read gate refused would have been one guess
away.

## Unmonitoring a season always asks

`set_monitoring` previews and asks for confirmation on every season and episode
write, even one that looks like it would change nothing. Only the whole-series
form reports "no change was made" without asking.

Sonarr's per-season `monitored` flag is an aggregate over the episode flags, and
this tool's own episode form writes those flags without touching the aggregate —
so a season can report itself unmonitored while its episodes are still
monitored. Treating that as "nothing to do" wrote nothing and left Sonarr
searching for exactly the episodes you were about to delete.
