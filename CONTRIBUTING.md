# Contributing

## You do not need a media stack

Every test runs against injected `fetch` mocks and recorded fixtures. CI never
touches a live service, and neither do you for normal development:

```bash
npm install
npm test
```

Maintainers with a real stack refresh the recorded fixtures with
`npm run capture` — see below. `npm run integration` goes the other way: it
*exercises* a live stack, calling every tool and reporting pass or fail per
tool, without recording anything.

## Testing, no code needed

If you run one of these, the most useful thing you can do is point arr-mcp at
it and tell me what happened. Please only test a service you actually run:
a report from a real instance is worth more than one from a stack set up for
the test.

- **qBittorrent.** Only login and health have been confirmed on a real server
  ([#195](../../issues/195)). Everything else is untested.
- **Plex.** Other versions and library layouts, especially managed user tokens.
- **Whisparr V2.** History, wanted, manual import and a few others are missing
  because they need captures from a live instance.
- **Cleanuparr with Transmission.** Only tested with qBittorrent so far.
- **Proxmox installer.** One person has reported a working install, and arm64
  is untested.

Open an issue either way. "It worked on version X" is a useful report, and so
is feedback that isn't a bug. Quote the version from `/healthz`. If you want to
test a branch, ask for a preview image (see
[Adding a service adapter](#adding-a-service-adapter)).

Adapters I would accept but will not build myself, because I don't run them:
Emby ([#500](../../issues/500)), Deluge ([#499](../../issues/499)),
Maintainerr ([#441](../../issues/441)), Sportarr
([#431](../../issues/431)) and Listenarr ([#432](../../issues/432)). Listenarr
also needs an argument for a stability waiver, since every release so far is
beta or canary.

## The three gates

CI runs exactly what you can run locally. Please make all three pass before
opening a PR:

```bash
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## If you are working with a coding agent

Welcome, and held to the same bar — not a lower one, and not a higher one.
arr-mcp is itself built with one. A patch is judged by whether it holds up, so
there is no separate review track and nothing to disclose beyond being straight
about what was actually verified.

This file is written to be read by an agent, and everything in it applies. Four
rules matter more than the rest, because breaking them produces a pull request
that *looks* finished:

- **Never write a fixture by hand.** Asked for one, an agent will produce
  something plausible — and a plausible fixture is worse than no fixture at all,
  because the test passes, the adapter ships, and the shape was never the
  service's. Capture with `npm run capture` against a live instance, or say in
  the PR that the fixture is missing.
- **Run the three gates and paste what they printed.** "Should pass" is not a
  result, and CI runs exactly what you can run locally, so there is nothing to
  guess about.
- **Say what a *human* exercised.** An agent cannot run your Lidarr. An adapter
  that has never touched a live service is still worth opening; one described as
  tested when nobody tested it is not, because the maintainer cannot check that
  claim for a service they do not run.
- **A typecheck failure against `src/services/generated/` is the codegen doing
  its job.** Fix the mapper; do not widen it with a cast. This is the one
  failure most likely to get papered over, and the cast survives long after the
  reason for it is forgotten.

## Dependencies

Dependabot runs monthly, plus immediate PRs for security advisories. Three
ecosystems are watched — `npm`, `github-actions` and the Docker base image —
and the last two are pinned by digest, which Dependabot rewrites in place
rather than unpinning. Only one rule groups updates — non-major bumps land as
a single PR per ecosystem — so a **major** bump of any dependency other than
TypeScript or Node arrives as its own PR, same monthly schedule, up to three
open at a time per ecosystem. The cadence is monthly; it is the "one PR" part
that stops being true once a major is involved. Two things Dependabot
deliberately will not do on its own:

- **TypeScript** is pinned with `~` because `typescript-eslint` declares a peer
  range it has to stay inside, and `.github/dependabot.yml` ignores that
  package outright — not only for majors. A TypeScript patch will never be
  proposed either; bumping it, of any kind, is a human decision.
- **Node majors** touch the Dockerfile, the CI workflow and `engines` together,
  so they are ignored in both the `npm` and `docker` ecosystems. Nothing will
  remind you; bumping Node is a deliberate, hand-written change.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — release-please
reads them to decide the next version and to write `CHANGELOG.md`.

| Prefix | Effect on version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | **major** |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none |

Pull requests are squash merged, so one subject line reaches `main`: the
commit's on a one-commit PR, and the PR title on anything longer. Make both
follow this format. If only no-bump types land, no release PR opens and nothing
ships, so a change a user or model can see is `fix:` or `feat:` even when the
code change looks like a refactor.

**What counts as breaking**, which is the part worth writing down:

- A tool renamed or removed
- A parameter renamed or removed
- A field removed from a response

Adding a tool, an optional parameter or a response field is a **minor** — those
are additive and nothing that reads the old shape stops working.

The pre-1.0 scheme is gone. Minors used to be reserved for roadmap phases, so a
`feat:` landed as a patch and the minor was cut deliberately with a
`Release-As:` footer; `bump-patch-for-minor-pre-major` in
`release-please-config.json` is what enforced it and is now inert. `RELEASING.md`
records how that worked, because two releases were nearly cut under the wrong
number by forgetting it.

## The tool surface is the public API

Renaming a tool or removing a parameter breaks every user's saved prompts and
agent configuration, and it breaks **silently** — the model stops finding the
tool rather than raising an error. Changes to tool names or parameters therefore
get stricter review than ordinary refactors. Since 1.0, a renamed tool keeps its
old name as an alias for one full minor, with the deprecation stated in the
tool's own description text.

Tool count has a ceiling because model accuracy degrades measurably past roughly
40 tools. There are 40 now, so the ceiling is reached and `test/app.test.ts`
fails on a forty-first. New capability extends an existing tool wherever it can.
Where it can't, a new tool is possible, but raising the ceiling needs a good
reason: the pull request says why no existing tool can carry the capability and
why it is worth the cost to every other tool, and it raises the limit in that
test as a visible part of the change.

**Prompt names are public surface too.** A client that has surfaced
`whats_wrong` as a slash command breaks when it is renamed, exactly as a saved
prompt breaks when a tool is. They are frozen at 1.0 on the same terms, and
`test/mcpPrompts.test.ts` asserts that no prompt names a tool that does not
exist — so a rename fails there rather than silently in someone's client.

**A resource must mirror a tool, never originate.** Client support for
resources is uneven and arr-mcp has to work on all of them, so anything only a
resource could answer would be unreachable wherever they are not surfaced. When
a resource needs a fact no tool reports, the fix is to extend the tool — that is
why `stack_health` reports per-instance permissions.

## Adding a service adapter

The highest-value contribution, and deliberately self-contained. Ten steps,
each with a worked example already in the tree.

### Which services qualify

An adapter is not a patch that lands and is finished. It is a standing
commitment to track someone else's release schedule, for a service the
maintainer very likely does not run and therefore cannot exercise in review —
only read. When it breaks, it breaks here, and the bug report arrives here.

That cost is worth paying for a service people actually run, that actually
makes arr-mcp better at its one job. It is not worth paying for a service that
will not exist in a year. Which of the two you are looking at is genuinely hard
to tell at the moment of the pull request, because the enthusiasm is identical.
So the bar is written down in advance rather than decided case by case. Four
things it is trying to establish, and the checks that stand in for them:

**Survival — will this still be here?**

- The service's first public release is **at least a year old**, and it has
  **commits within the last sixty days**. Both halves, because neither implies
  the other: self-hosted projects die overwhelmingly between months two and six
  — after the launch thread, before the first real maintenance burden — and a
  project can clear that cliff and then be abandoned with its version number
  intact.

  A year rather than six months, because surviving the cliff is not the same as
  being maintained. Six months buys a project that outlived its launch thread. A
  year buys one that has been through a dependency bump nobody enjoyed, a
  breaking change in something upstream, and the point where the original
  author's spare time went somewhere else. It is also roughly the horizon the
  adapter has to keep working over, so it is the horizon worth asking about.

**Stability — will the adapter still work?**

- **1.0 or later**, or a documented, versioned API with a stated compatibility
  policy. A pre-1.0 API is free to move, and an adapter pinned to one breaks on
  the service's schedule rather than ours.
- **Published API documentation.** OpenAPI is preferred and earns code
  generation for free, but several adapters here are hand-written against a
  plain written reference, and that is enough.

**Demand — does anyone want it?**

- **Packaged where people deploy** — Unraid Community Applications, TrueNAS
  apps, linuxserver.io, or an official image with meaningful pull counts. Stars
  can be manufactured; a place in a distribution channel is harder to.
- **Someone other than the service's own author has asked for it.** Not a
  judgement about anyone's motives. The author of a service is simply the last
  person able to tell whether anyone *else* wants the integration, and their own
  enthusiasm is not evidence that they do.

**Fit — does it belong in this server?**

- **It sits on the chain `diagnose` walks** — requested, managed, monitored,
  downloaded, indexed, imported, scanned. arr-mcp exists because the interesting
  questions live between services. A service that cannot make `diagnose` smarter
  is a second product, not a seventeenth adapter.
- **It adds no new tool**, or the pull request argues explicitly for the one it
  adds. The forty-tool ceiling above is already reached, so that argument has
  to justify raising it, and a new service does not get to raise it quietly.
- **It introduces no new risk class.** Code execution, credential brokering, or
  outbound requests to hosts the operator never configured are changes to the
  security model. Those get decided on their own terms, never as a side effect
  of adding an adapter.

This is a floor for what will be considered, not a ceiling on what can be
accepted. Any of it can be waived — on the pull request, in writing, with the
reason — and a rewrite shipping from a fresh repository is exactly what that is
for. An adapter that misses on age alone is worth an issue rather than a
weekend: the answer to that one is a date, not a no.

### What would be accepted today

The bar above is abstract, so here is the concrete answer, current as of
2026-11-02. Grouped by slot on the chain rather than alphabetically, because
that is the real question: a second service in a slot that already exists is a
small, shaped change, and a service in no slot at all is a different product.

**Managed — what decides something should exist**

- **Lidarr — the rest of it.** The adapter has shipped, with twenty-five capabilities. `LibraryCapable` and `SearchCapable`, so
  `get_library` lists artists, `search_media` finds them, and its discover
  source (`lookup_media`) finds artists to add. `MediaAddCapable` and
  `MetadataProfileCapable`, so `add_media` adds one by its MusicBrainz id, with
  the metadata profile beside the quality profile. `MediaUpdateCapable`, so
  `update_media` changes an artist's profiles, root folder, monitoring and tags
  later, through the Artist Editor. The lookup, add and editor fixtures were
  captured on a 3.1.6.5079 test instance.
  `MediaDetailCapable`, so `get_media_details` lists an artist's albums and the
  album ids a write needs. `MonitoringCapable`, so `set_monitoring` writes an
  album's flag. `MonitorStateCapable`, so that flag is read before it is changed
  and a no-op is reported as one. `ArtistMonitorCapable`, so an artist's standing
  policy is read and written as a set. `QueueCapable`, `HistoryCapable` and
  `BlocklistCapable` are the shared `arr*` helpers with `kind: 'artist'`, so
  `get_queue`, `get_history` and `get_blocklist` include Lidarr; their fixtures
  were captured from Lidarr 3.1.0.4875 with download activity, and the reads
  were exercised against 2.1.3.3927 and 3.1.6.5079. `QueueRemoveCapable` is the
  shared `removeArrQueueItem`, so `remove_queue_item` and `clean_queue` take
  Lidarr. `LibraryScanCapable`, `LibraryMaintenanceCapable`,
  `ManualImportCapable` and `CommandStatusCapable` are the shared helpers, with
  `resource: 'artist'` where they take one, so `trigger_scan` rescans, renames
  and imports a finished download for Lidarr, and `stack_health` follows the
  commands it queues. `DiskSpaceCapable`, `HealthCheckCapable` and
  `ScanStateCapable` are the shared `arr*` system reads, so `stack_health` also
  reports Lidarr's disks, failing health checks and last `RescanFolders` (its
  disk scan). `WantedCapable` and `CalendarCapable`, so `get_wanted` and
  `get_calendar` list albums: a wanted row names its artist as `id` and the
  album as `albumId`, and the wanted cutoff fixture was captured from Lidarr
  3.1.0.4875. `SearchTriggerCapable`, `ReleaseSearchCapable` and
  `ReleaseGrabCapable`, so `trigger_search` searches the indexers for an artist
  or some of its albums, and `get_releases` and `grab_release` list and grab the
  releases for the artist or one album; the release fixture was captured from
  an album search on Lidarr 3.1.6.5079. What it still lacks is deleting artists.
  All 21 capture endpoints were exercised against a live Lidarr 3.1.6.5079 and
  the fixtures are committed, but two still have no rows: tag and indexer are
  empty on a fresh instance. Tags are read anyway, with the shared `readTags`
  and the spec's `id` and `label`: `add_media` matches a tag it is given, and
  `stack_health` lists them at `detail: "full"`. The indexer row shape still
  needs a capture against a library with real activity before a read adapter can
  claim it. The two monitoring write responses were captured separately, on a
  throwaway 2.1.3.3927 instance.

  **The design constraint.** Music sits in the merged index as its own `kind`,
  `artist`, and joins because its identity is a MusicBrainz MBID: a GUID, where
  films and series key on integer TMDB, TVDB and IMDb ids. Jellyfin publishes the
  same GUID on an album artist and Plex on an artist in a music section, so the
  join works — and it is namespaced by kind, so an MBID can never collide with
  the integer spaces. `get_media_details` answers for an artist. `diagnose` and
  `fix_metadata` still read the film and series chain, and refuse an artist —
  by query or by Lidarr id — naming `get_media_details` with `detail: "full"`
  for the albums and `get_library`'s `kind: "artist"` for the artist list,
  rather than reporting it as absent. The music read is its own source in a
  library build, so a failed or absent one reports `unknown` presence rather than
  claiming every artist is `arr_only`. It runs only when a Lidarr is configured:
  with no artist row to join to, it would add the whole music collection as
  `jellyfin_only`.

  **What its API does not say out loud.** Three media levels, so `resource:
  'movie' | 'series'` in the shared `arr*.ts` helpers does not apply. Two
  profiles gate what gets monitored: quality and metadata. `RootFolderResource`
  carries no `unmappedFolders`, and it does carry default profile and monitor
  fields the shared `RootFolder` type has no room for. History ordinals move
  too: `downloadIgnored` is 10, where Sonarr has it at 7. An *artist* carries an
  added date, so `sort: "added"` works for music; an *album* has no added date
  and no per-album quality, which is why the library rows on artists and albums
  live under `get_media_details`.

**Downloaded — where a grab actually lands**

- **Deluge** ([#499](../../issues/499)). The last mainstream client this server cannot talk to. Same slot
  as SABnzbd, NZBGet, Transmission and qBittorrent, documented JSON-RPC, no new
  tool.
  Its one wrinkle is that the Web UI talks to a separate daemon, so a reachable
  Web UI with a disconnected daemon is a failure mode `testConnection` has to
  report as itself rather than as a generic upstream error.

**Imported and played — the library a person opens**

- **Emby** ([#500](../../issues/500)). Jellyfin's ancestor, near-identical API, and therefore the cheapest
  adapter on this list — plausibly a variant of the Jellyfin one rather than a
  new file.
- **Plex — more testers.** The adapter has shipped and has been verified against a live Plex Media
  Server 1.43.3.10896 by a volunteer tester (issue #180): all nine endpoints
  it reads were captured from that server and are contracted in
  `test/contract.test.ts`. It reads, and writes with `trigger_scan`, verified
  against 1.43.1.10611 (issue #268), and `fix_metadata`, which has repaired films
  and series on a live server (issue #312) and so is on by default, behind
  `permissions.destructive`. The maintainer still does not
  run Plex, so coverage is two servers' worth, not a range — further testers
  on a different version or library shape would still be useful, particularly
  for the managed-user-token case `docs/tools.md` flags as unconfirmed.

  **The design still governs.** Plex's usual auth brokers through plex.tv —
  credential brokering *and* an outbound request to a host the operator never
  configured, which is the risk class above and a no on its own terms. This
  adapter takes an operator-supplied `X-Plex-Token` and talks only to the
  configured local server, never plex.tv. That constraint holds for any future
  change here, not just this one.

**Beside the chain — the live TV the same media servers play**

- **Dispatcharr — writes.** The adapter has shipped, read-only, by maintainer
  waiver on 2026-11-03. It missed three checks above: it is pre-1.0, only the
  maintainer asked for it, and live TV never passes through the chain `diagnose`
  walks. The waiver rests on one thing: Dispatcharr is where the Plex and
  Jellyfin servers arr-mcp already watches get their live TV, so a failing
  playlist or guide is a fault in the stack `stack_health` is asked about. That
  is the whole precedent. It does not extend to analytics or other services that
  merely sit near a media server, which is why Tautulli stays below. Building
  playlists, that is channel profiles, needs its own case: it spends at least
  one new tool against the ceiling, and its writes change what every client of
  that playlist sees.

**Beside the chain — the books the same stack downloads**

- **Shelfmark — audiobooks.** The adapter has shipped by maintainer
  waiver on 2026-11-05. It missed two checks above: only the maintainer asked for
  it, and a book never passes through the chain `diagnose` walks, so `diagnose`
  leaves its queue out. It also comes close to the risk-class check:
  `SHELFMARK_API_KEY` is root-equivalent, and an install with authentication on
  needs it to find or grab a book; with no authentication set up there is no key to
  store, and the read-only key still gives `stack_health`. The waiver rests on one
  thing: Shelfmark is a downloader run beside the rest of the stack, and finding,
  grabbing, cancelling and retrying a book fit the existing `lookup_media`,
  `get_releases`, `grab_release`, `remove_queue_item`, `retry_download` and
  `get_history` with no new tool. Ebooks only so far.

- **Grimmory.** The adapter and its writes are in, by maintainer waiver on
  2026-11-07. The writes cover rescans, deletes, the Bookdrop, read status and
  metadata. It missed three checks above: the project is eight months old
  (first release 2026-03-20), only the maintainer asked for it, and a book never
  passes through the chain `diagnose` walks, so `diagnose` refuses one. The age
  miss is the one Chaptarr was turned down on, so the reason is written down.
  Grimmory is the one book library with a management API to build on: Calibre's
  content server has an undocumented JSON interface with no version policy, and
  BookOrbit has no management API to speak of. It carries BookLore's older
  codebase and release numbering, and the maintainer runs it, so every change gets
  tested against a live v3.5.0. The rest of the waiver is Shelfmark's: the books
  the stack downloads have to land somewhere, and without the library half
  `stack_health` can see a download finish and never see where it went. The risk
  class holds, since it stores a username and password as Transmission and
  qBittorrent do, and talks only to the configured host. The waiver covers
  Grimmory alone. A Chaptarr request still waits for its date.

Named and **not** accepted, so nobody spends a weekend finding out:

- **Readarr.** Archived upstream. Nothing to track.
- **Chaptarr.** Public since June 2026, so it misses on age alone. This is the
  date-not-a-no case, and it is on this list so the date is visible rather than
  discovered in review.
- **Tautulli.** Plex watch analytics. Real and well-run, and off the chain — it
  cannot make `diagnose` smarter, which makes it a second product.
- **Recyclarr.** A config sync tool rather than a service with state worth
  asking about. There is no question `diagnose` would put to it.
- **autobrr.** Sits beside the chain rather than on it — it filters releases
  into a client this server already reads. It would spend new tools to answer
  questions the queue mostly already answers.

Anything not named here is undecided rather than refused. Ask in an issue and it
gets held against the four checks above, which is cheaper for everyone than
finding out afterwards.

**You will have to test it yourself, properly.** The maintainer runs neither
Lidarr, Plex, qBittorrent nor Cleanuparr. Lidarr's read fixtures came from a live 3.1.6
library with 1,578 artists and no download activity, and its two monitoring write fixtures
from a temporary 2.1.3.3927 instance. Its queue, history, blocklist and wanted
cutoff fixtures came later, from a 3.1.0.4875 library with real download activity.
Plex has an adapter
and, as of a volunteer tester's report on [issue #180](../../issues/180), has
been exercised against a real instance. [qBittorrent](../../issues/147) has an
adapter too, exercised against a real 5.2.3 server in [#195](../../issues/195)
for login and health only. Cleanuparr was tested by its requester on a live
2.10.12 with qBittorrent 5.3.0 in [#308](../../issues/308), and those captures
are its fixtures; its Transmission path has not met a real instance. Reclaimerr
was tested by its requester on a live 0.6.5 in [#402](../../issues/402), and
those captures are its fixtures; it has not yet deleted anything there, so its
deletion events are tested on a captured candidate inside a constructed event.
Dispatcharr is the exception: the maintainer runs it, and its fixtures were
captured from a live 0.33.0. So is Shelfmark, captured from a live v1.6.1 with no
authentication, including a real grab; it has had no failed download there, and
its key handling and its stopped and failed paths are tested on captured bodies
with those answers constructed. So is Grimmory, captured from a live v3.5.0 as
the admin account; its Bookdrop was empty, so a pending file is tested on a
constructed one, and so are its 403 answers.
Whichever you take on, your testing is the only
testing it gets before it ships.

Concretely: run it against your own live instance, say in the pull request what
you tested and against which version, and capture fixtures from the real service
rather than writing them by hand. A test that passes against an invented shape
proves nothing about the service it claims to support.

If you are testing someone else's build rather than your own, ask for a preview
image on the issue. The maintainer can publish any branch to
`ghcr.io/bardesss/arr-mcp:preview-<name>` with the **Preview image** workflow, so
you change one line of your compose file instead of installing a toolchain. A
preview reports a version like `preview-plex-a1b2c3d` on `/healthz`, which is
what a useful bug report quotes. It is not a release and never moves `latest`.

And write down whatever surprised you. Every adapter here carries a note about
something its API does that the documentation does not mention — SABnzbd
reporting gigabytes as a string, Sonarr's rating arriving unlabelled, Jellyfin
localising its task names. Those notes have prevented more bugs than the code
around them.

1. **Add the service id** to `ServiceIdSchema` in `src/config/schema.ts`, a
   schema for it in `ServicesSchema`, and its entry in `ConfigByService`. Reuse
   `KeyedServiceSchema` unless the service authenticates differently. A
   single-instance service is wrapped in `singleOnly(...)`; a read-only one uses
   `ReadOnlyKeyedServiceSchema` and joins `READ_ONLY_SERVICES`, which forces its
   write permissions off, as Cleanuparr, Reclaimerr and Dispatcharr do. `test/config.test.ts`
   is where the config cases go.
2. **Set its minimum version** in `MINIMUM_VERSIONS` in
   `src/services/versions.ts`, with a comment saying what the floor rests on.
   It is a `Record<ServiceId, …>`, so a missing entry is a compile error rather
   than a silent gap; `test/versions.test.ts` covers it.
3. **Pick or write an auth strategy** in `src/core/auth.ts`. The existing shapes
   cover most services; write a new one only if the service does something
   genuinely different, as Transmission's session handshake and qBittorrent's
   cookie login do.
4. **Add its endpoints** to `ENDPOINTS` in `scripts/capture-fixtures.ts` and run
   `npm run capture -- <your-service>` against a live instance. Name the service:
   the bare command rewrites every fixture your config can reach. Review the diff.
5. **Write the adapter** in `src/services/<id>.ts`, implementing `ServiceAdapter`
   plus whichever capability interfaces the service actually supports. A
   capability no existing service has gets its interface and type guard in
   `src/services/types.ts`, and the tools that should use it — usually
   `stack_health` and `diagnose`'s `chain.ts` and `evidence.ts` — read it
   through that guard.
   `src/services/sonarr.ts` is the simplest example; `src/services/transmission.ts`
   and `src/services/qbittorrent.ts` are the most unusual.
   A media server implements `PlaybackCapable`, `UserLibraryCapable` and
   `UserDirectoryCapable` — together `MediaServerAdapter` — and exactly one may
   be configured, because `get_library`'s `presence` join needs a single
   counterparty.
6. **Decide whether it can be configured twice**, and say so in the adapter.
   Nine of the nineteen services can be, so this is the common case rather than the
   exotic one — but copying `jellyfin.ts` gets you `readonly id: string =
   '<type>'`, which is the *single*-instance shape. That is the safe default
   (a service that simply cannot be configured twice, rather than two adapters
   with colliding ids), so getting it wrong fails closed. Making it
   multi-instance is four moves:

   - accept its entry from `ConfigByService` in `src/config/schema.ts` — that
     entry carries a phantom `__service` tag, so taking the bare config type
     instead silently gives up the check that stops your adapter being handed
     another service's config,
   - set `readonly instance` from `config.name`,
   - derive `readonly id` with `instanceId()` rather than a type literal,
   - **pass `this.id` into `ServiceHttp`, not the type literal.**

   That last one is the trap. `ServiceHttp` puts the id it was given into every
   error it raises, so a hardcoded literal there produces errors blaming
   `qbittorrent` when the failure was `qbittorrent/vpn` — and a service that
   authenticates *outside* `ServiceHttp` needs the same care in its own login
   path. qBittorrent does exactly that, and its login errors had to be fixed
   separately from the rest of the adapter for precisely this reason.

7. **Declare its contract** in `test/contract.test.ts` — the response fields your
   adapter reads. Omit the `spec` when the service publishes no OpenAPI document.
8. **Register it** in `src/services/registry.ts`, and add cases for what it
   serves to `scripts/integration.ts` so a live run exercises it.
9. **Draw it an icon** in `src/web/icons.ts` — stroke-only, `currentColor`, on
   the same 24×24 grid as the rest, saying what kind of thing the service is
   rather than which one. The UI uses one drawn set rather than per-service
   artwork, so a new icon is drawn to match the others instead of sourced. A
   test fails if a service id has no icon.
10. **Document it** in `docs/configuration.md` (its config block) and
    `docs/tools.md` (what each tool now says about it), and add it to the
    service line, requirements and thanks in the README.

An adapter must:

- return a `ConnectionDiagnosis` from `testConnection`, **never a boolean** and
  **never a thrown error** — use `diagnoseConnection`, which every adapter shares
- accept an injectable `fetch` so it is testable without the service
- **not implement a capability it has no fixture for.** Prowlarr is not
  `DiskSpaceCapable` because its diskspace endpoint 404s. A method nothing has
  tested is a method `stack_health` will call in production

Transport concerns — timeouts, retries, the circuit breaker, error
classification — belong to `ServiceHttp` and must not be reimplemented in an
adapter. If a service needs behaviour `ServiceHttp` does not have, that is a
change to `ServiceHttp`, so every service gets it.

### If your service returns free text

Release names, overviews, file paths and user notes must be passed through
`fenceText` **in the adapter**, at the point the value enters our types — not in
a tool, where one forgotten field is a silent hole. `test/injection.test.ts`
asserts the fence holds; add a case there if your service can return something
the existing ones do not cover.

**Match on stable identifiers, not on display strings.** Both scan-state
implementations learned this the hard way: Radarr runs three tasks whose names
contain "Refresh", only one of which is the library scan, and Jellyfin's task
names are localised — a Dutch server returns "Mediabibliotheek scannen".

Eight of the nineteen services publish no usable OpenAPI spec, and two more
have hand-written adapters anyway, so the adapter
interface is defined by us and must stay hand-writable. Code generation is an
implementation detail inside an adapter, never the shape of the contract.

That also decides what the nightly drift job can watch. `openapi-drift.yml`
re-fetches the nine published specs and regenerates types from them, so it
catches an upstream change before a user does. A spec-less service has nothing
to fetch: its contract is the fields declared in `test/contract.test.ts`,
checked against committed fixtures. That catches us breaking our own adapter,
and it cannot catch the service changing underneath it. For those eight, the
only real drift detector is somebody recapturing fixtures against a live
instance.

## Adding a write tool

Write tools are **not** registered like read tools. Use `registerWriteTool`
(`src/tools/write.ts`) and supply only two callbacks:

- `plan(args)` — resolves the arguments into a `WritePlan`: the concrete
  `target` id, a one-sentence `summary`, and an itemised `effects` list. It must
  not mutate anything. Set `noop: true` when there is nothing to do, and the
  harness skips the confirmation rather than asking the user to approve a
  no-op.
- `apply(plan, args)` — performs the write. It is reached only after the
  permission tier passed, a valid single-use confirmation token was presented,
  and an audit row was opened.

The four §10 guarantees — the tier check, `dry_run`, the audit trail, the
confirmation handshake — are properties of the harness, not of your tool. Do not
reimplement any of them, and do not call an adapter's write method from `plan`:
the preview phase must be incapable of mutating, and it is, because the harness
simply does not invoke `apply`.

`src/tools/triggerSearch.ts` is the worked example. Note two things it does that
yours should:

- **`service` is derived from the arguments**, not fixed, for a tool spanning
  more than one service. A fixed id would check Sonarr writes against Radarr's
  `permissions` block.
- **It takes `service` + `id`, never a title.** Fuzzy title resolution is fine
  when a wrong match costs a wrong answer; it is not fine when it costs an
  action against the wrong item.

Pick the tier by what an undo costs. `safe` is anything the service can reverse
— monitor, unmonitor, trigger a search. `destructive` is anything that loses
data: files on disk, a request's history, a blocklist entry. When unsure, it is
`destructive`; the cost of over-classifying is one config flag, and the cost of
under-classifying is someone's library.

## Working on the config UI

Server rendered from `src/web/`, no build step and no framework. `tsc` does not
emit non-TypeScript files, so **assets live in modules, not in a `public/`
directory** — a static file would work in development and be silently missing
from the Docker image.

Three rules, each of which exists because breaking it is quiet rather than
loud:

- **Every interpolation goes through `html`/`esc`.** Release names from public
  indexers reach the log table and the audit view, and they are the most
  attacker-controllable strings in the system (§11). `raw()` is the only escape
  hatch and has to be written on purpose.
- **The live log stream is JSON, and the client builds rows with
  `textContent`.** Not `innerHTML`. Everything else on the page is
  server-rendered through the escaping template, which is sound — but that one
  surface carries indexer text on a timer, and building nodes makes an XSS
  impossible rather than merely unlikely.
- **A secret is never rendered back.** API keys, the NZBGet and torrent-client
  passwords and the UI password all render as empty fields meaning *unchanged*. That is also
  why an empty field can never mean "clear this" — clearing is expressed by
  switching the service off.

Anything a config change can invalidate belongs in `core/runtime.ts`, behind
the snapshot swap, and is read **per request** rather than captured when the
app is built. Capturing it is what made a restart necessary before. Two things
deliberately live outside the snapshot and survive a reload: confirmation
tokens, because a write handshake spans two calls, and sessions, because a
config edit must not log you out of the page you are editing from.

A new config key needs a place in the [management API](docs/api.md) too, or a
reason it stays on the page. `test/apiParity.test.ts` lists every key, service
fields included, and fails on one it has not placed.

## Vendored API specs

`specs/*.json` are upstream OpenAPI documents, refreshed by `npm run specs:fetch`
and regenerated into `src/services/generated/` by `npm run codegen`. Both are
committed, and they move together — a spec refreshed without a regeneration
leaves the types describing an API that no longer exists. A nightly workflow
does both and opens a PR when either changes, so **review `specs/` in that
diff** — the generated files are output, not source, and are not meant to be
read by hand.

Radarr, Sonarr, Whisparr, Lidarr, Prowlarr, Jellyfin, Seerr, Profilarr and Grimmory are generated.
Bazarr, SABnzbd, NZBGet, Transmission, qBittorrent, Plex and Cleanuparr publish no usable spec
and are hand-written against recorded fixtures. Reclaimerr publishes OpenAPI at
`/api/v1/openapi.json`, but its adapter reads seven endpoints and is
hand-written too, against fixtures captured from 0.6.5. Dispatcharr serves
OpenAPI only at runtime (`/api/swagger.json`), with nothing committed for the
nightly check to fetch, so its adapter is hand-written against fixtures
captured from 0.33.0 and pins the minor it was written for instead. Shelfmark
publishes no spec, only a written API page, and is hand-written against fixtures
captured from v1.6.1.

### The nightly compatibility check

The same workflow runs `test/contract.test.ts` against the freshly fetched
specs and `npm run typecheck` against the types regenerated from them, so it
can tell an upstream change that breaks this project from one that does not.
The two catch different halves: the contract test, a field an adapter reads
that is no longer declared; the typecheck, one that changed shape under a
mapper. A red run means either; the PR body names the failing entries.

The PR is opened with the default `GITHUB_TOKEN`, which GitHub refuses to let
trigger other workflows, so it arrives with no status checks. Close and reopen
it to run CI. The eight hand-written services are invisible to this check — only a
live call catches their drift.

Two things worth knowing before you touch this:

- **The generator runs through `npx` at a pinned version, not as a
  devDependency.** `openapi-typescript` requires `typescript@^5.x` and this
  project is pinned to TypeScript 6, so a local install cannot resolve. Running
  it in npx's isolated tree keeps the conflict out of ours, and the tool is not
  part of the shipped artefact — its reviewed output is.
- **The generated types are nullable where the spec says nullable.** If a mapper
  fails to typecheck against them, fix the mapper. Do not widen it with a cast:
  that failure is the codegen doing the job it was added for.

## Screenshots

`screenshots/` is regenerated, never taken by hand:

```bash
npx playwright install chromium   # once; the npm package ships no browser
npm run screenshots
```

Every page in `docs/` and the README comes from `scripts/lib/uiFixture.ts` —
invented services, frozen timestamps, no config read and no service contacted.
That is deliberate rather than convenient: these pages render token names,
the MCP endpoint host and every service URL, and `screenshots/` is public.
Frozen timestamps also mean a re-run only changes a PNG when the UI changed.

The fixture is typed against the page functions' own parameters, so a page that
gains a required field fails `npm run typecheck` here rather than quietly
producing a screenshot of something that is no longer the product.

## Recorded fixtures

Adapter tests run against real responses captured once from a live stack, so
neither CI nor a contributor needs one. Maintainers refresh them with:

```bash
npm run capture            # reads ./config/config.yaml, never prints credentials
npm run capture -- plex    # only that service, leaving every other fixture alone
```

Set `ARR_MCP_CAPTURE_CONFIG` to read credentials from outside the repo.

**Name the service unless you mean to refresh all of them.** The bare command
captures every service your config holds, which is right for a maintainer
refresh and wrong for anyone capturing one service as a favour: it produces a
diff rewriting fixtures for services nobody asked about, carrying your data,
and leaves you to work out which files to discard. An unknown name is refused
rather than silently capturing nothing, because the script writes no file for a
service it never matched and a quiet empty run looks exactly like a server that
answered nothing.

**Naming it does not narrow it to one endpoint.** `-- plex` still rewrites every
Plex fixture, so capturing one new endpoint also replaces the nine already there
with your own server's data, and the adapter tests fail on the drift. That is the
discard the filter cannot do for you: keep the file you were asked for and
`git checkout` the rest. Issue #272 is what it looks like in practice, ten
captured and nine discarded.

### Webhook payloads

An *arr sends these rather than answering a request, so they have their own script:

```bash
npm run capture:webhooks          # port 9099, or pass another
```

It prints a URL per service and a password that exists only for that run. Add a
Webhook connection in the *arr with those, press Test, then cause the real events.
Each event type keeps one file in `test/fixtures/webhooks/<service>/`, and a repeat
overwrites it. Radarr, Sonarr and Lidarr only: Whisparr is refused because titles
are kept, and on Whisparr the titles are the sensitive part.

**Read every file before committing it.** Paths, release names, indexers and
download ids are replaced by field name, so a field nobody has seen yet can get
through. Re-adding a series you deleted may start a search and real downloads, so
leave that option off if you don't want them.

The script scrubs two different things, and the distinction matters:

- **Credentials** — every configured API key and password, plus any
  secret-named field. It then **refuses to write the file** if one survived. A
  reviewer spotting a leaked key in a large diff is not a control worth relying
  on.
- **Identity** — account names, email addresses, avatar URLs (a gravatar URL
  embeds a hash of the email), indexer names and URLs, every configured host,
  and private IPv4 literals. None of these is a secret; all of them are
  permanent once committed to a public repository.

Identity scrubbing is declared **per endpoint**, not by key name, and that is
deliberate: `Name` is an account on Jellyfin's `/Users` and a scheduled task on
`/ScheduledTasks`. A blanket rule on the key would destroy the fixture that
tells us which task scans the library.

Real film and series titles are kept — they are not sensitive and they keep the
fixtures realistic, which is most of the value of recording them.

`test/fixtures.test.ts` re-checks every committed fixture on every PR, so a
recapture years from now cannot quietly leak either. It works on key names and
value shape, not on the secrets themselves, because CI does not have them.

Review `git diff test/fixtures/` before committing regardless.

## Reporting a bug

Please include service versions, your arr-mcp version, and redacted logs.
Redact API keys and the bearer token.
