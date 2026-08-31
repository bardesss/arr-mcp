# Contributing

## You do not need a media stack

Every test runs against injected `fetch` mocks and recorded fixtures. CI never
touches a live service, and neither do you for normal development:

```bash
npm install
npm test
```

Maintainers with a real stack refresh the recorded fixtures with
`npm run capture` — see below. An integration script that *exercises* a live
stack rather than recording it is planned for 0.4.

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

Renovate runs monthly, plus immediate PRs for security advisories. Only one
rule groups updates — non-major bumps land as a single PR — so a **major**
bump of any dependency other than TypeScript or Node arrives as its own PR,
same monthly schedule, up to `prConcurrentLimit: 3`. The cadence is monthly;
it is the "one PR" part that stops being true once a major is involved. Two
things Renovate deliberately will not do on its own:

- **TypeScript** is pinned with `~` because `typescript-eslint` declares a peer
  range it has to stay inside, and `renovate.json` disables Renovate for that
  package outright — not only for majors. A TypeScript patch will never be
  proposed either; bumping it, of any kind, is a human decision.
- **Node majors** touch the Dockerfile, the CI workflow and `engines` together,
  so they wait for approval on the dependency dashboard.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — release-please
reads them to decide the next version and to write `CHANGELOG.md`.

| Prefix | Effect on version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | **major** |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none |

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

Tool count is a hard constraint, not a preference: model accuracy degrades
measurably past roughly 40 tools. New capability should extend an existing tool
before it adds one.

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

The highest-value contribution, and deliberately self-contained. Seven steps,
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
  generation for free, but three adapters here are hand-written against a plain
  written reference, and that is enough.

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
  is a second product, not a ninth adapter.
- **It adds no new tool**, or the pull request argues explicitly for the one it
  adds. The forty-tool ceiling above is a hard constraint, and a new service
  does not get to spend it quietly.
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
2026-08-16. Grouped by slot on the chain rather than alphabetically, because
that is the real question: a second service in a slot that already exists is a
small, shaped change, and a service in no slot at all is a different product.

**Managed — what decides something should exist**

- **Lidarr.** The clearest yes on this page. Servarr family, the same API shape
  Radarr and Sonarr are already written against, on the chain by construction,
  and it very likely spends no new tool: music maps onto `get_library`,
  `get_queue`, `get_calendar` and the existing writes.

**Downloaded — where a grab actually lands**

- **Deluge.** The last mainstream client this server cannot talk to. Same slot
  as SABnzbd, Transmission and qBittorrent, documented JSON-RPC, no new tool.
  Its one wrinkle is that the Web UI talks to a separate daemon, so a reachable
  Web UI with a disconnected daemon is a failure mode `testConnection` has to
  report as itself rather than as a generic upstream error.

**Imported and played — the library a person opens**

- **Emby.** Jellyfin's ancestor, near-identical API, and therefore the cheapest
  adapter on this list — plausibly a variant of the Jellyfin one rather than a
  new file.
- **Plex.** A read-only adapter now exists, written against Plex's documented
  but unverified API. It is not merge-ready: nobody here runs Plex, so nothing
  in it has been exercised against a real server, only read.

  **The design still governs.** Plex's usual auth brokers through plex.tv —
  credential brokering *and* an outbound request to a host the operator never
  configured, which is the risk class above and a no on its own terms. This
  adapter takes an operator-supplied `X-Plex-Token` and talks only to the
  configured local server, never plex.tv. That constraint holds for any future
  change here, not just this one.

  **Testers are what is missing.** If you run Plex and are willing to test a
  build against it and report back — what worked, what didn't, against which
  version — say so in an issue. That is what turns this from a draft into
  something that can ship.

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
Lidarr, Plex nor qBittorrent. Lidarr has no adapter yet; Plex and qBittorrent
do, but neither has ever been exercised against a real instance —
[Plex](../../issues/180) and [qBittorrent](../../issues/147) are both
unverified for the same reason. Whichever you take on, your testing is the
only testing it gets before it ships.

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

1. **Add the service id** to `ServiceIdSchema` in `src/config/schema.ts`, and a
   schema for it in `ServicesSchema`. Reuse `KeyedServiceSchema` unless the
   service authenticates differently.
2. **Pick or write an auth strategy** in `src/core/auth.ts`. The existing shapes
   cover most services; write a new one only if the service does something
   genuinely different, as Transmission's session handshake and qBittorrent's
   cookie login do.
3. **Add its endpoints** to `ENDPOINTS` in `scripts/capture-fixtures.ts` and run
   `npm run capture` against a live instance. Review the diff.
4. **Write the adapter** in `src/services/<id>.ts`, implementing `ServiceAdapter`
   plus whichever capability interfaces the service actually supports.
   `src/services/sonarr.ts` is the simplest example; `src/services/transmission.ts`
   and `src/services/qbittorrent.ts` are the most unusual.
   A media server implements `PlaybackCapable`, `UserLibraryCapable` and
   `UserDirectoryCapable` — together `MediaServerAdapter` — and exactly one may
   be configured, because `get_library`'s `presence` join needs a single
   counterparty.
5. **Declare its contract** in `test/contract.test.ts` — the response fields your
   adapter reads. Omit the `spec` when the service publishes no OpenAPI document.
6. **Register it** in `src/services/registry.ts`.
7. **Draw it an icon** in `src/web/icons.ts` — stroke-only, `currentColor`, on
   the same 24×24 grid as the rest, saying what kind of thing the service is
   rather than which one. The UI uses one drawn set rather than per-service
   artwork, so a new icon is drawn to match the others instead of sourced. A
   test fails if a service id has no icon.

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

Four of the nine services publish no usable OpenAPI spec, so the adapter
interface is defined by us and must stay hand-writable. Code generation is an
implementation detail inside an adapter, never the shape of the contract.

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
- **A secret is never rendered back.** API keys, the torrent-client passwords and
  the UI password all render as empty fields meaning *unchanged*. That is also
  why an empty field can never mean "clear this" — clearing is expressed by
  switching the service off.

Anything a config change can invalidate belongs in `core/runtime.ts`, behind
the snapshot swap, and is read **per request** rather than captured when the
app is built. Capturing it is what made a restart necessary before. Two things
deliberately live outside the snapshot and survive a reload: confirmation
tokens, because a write handshake spans two calls, and sessions, because a
config edit must not log you out of the page you are editing from.

## Vendored API specs

`specs/*.json` are upstream OpenAPI documents, refreshed by `npm run specs:fetch`
and regenerated into `src/services/generated/` by `npm run codegen`. Both are
committed, and they move together — a spec refreshed without a regeneration
leaves the types describing an API that no longer exists. A nightly workflow
does both and opens a PR when either changes, so **review `specs/` in that
diff** — the generated files are output, not source, and are not meant to be
read by hand.

Radarr, Sonarr, Prowlarr, Jellyfin and Seerr are generated. Bazarr, SABnzbd,
Transmission and qBittorrent publish no usable spec and are hand-written against
recorded fixtures.

### The nightly compatibility check

The same workflow runs `test/contract.test.ts` against the freshly fetched
specs and `npm run typecheck` against the types regenerated from them, so it
can tell an upstream change that breaks this project from one that does not.
The two catch different halves: the contract test, a field an adapter reads
that is no longer declared; the typecheck, one that changed shape under a
mapper. A red run means either; the PR body names the failing entries.

The PR is opened with the default `GITHUB_TOKEN`, which GitHub refuses to let
trigger other workflows, so it arrives with no status checks. Close and reopen
it to run CI. The three spec-less services are invisible to this check — only a
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
That is deliberate rather than convenient: these pages render the bearer token,
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
```

Set `ARR_MCP_CAPTURE_CONFIG` to read credentials from outside the repo.

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
