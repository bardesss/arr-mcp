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
| `feat!:` or a `BREAKING CHANGE:` footer | minor while on 0.x, major after 1.0 |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none |

## The tool surface is the public API

Renaming a tool or removing a parameter breaks every user's saved prompts and
agent configuration, and it breaks **silently** — the model stops finding the
tool rather than raising an error. Changes to tool names or parameters therefore
get stricter review than ordinary refactors. After 1.0, a renamed tool keeps its
old name as an alias for one full minor, with the deprecation stated in the
tool's own description text.

Tool count is a hard constraint, not a preference: model accuracy degrades
measurably past roughly 40 tools. New capability should extend an existing tool
before it adds one.

## Adding a service adapter

The highest-value contribution, and deliberately self-contained. Six steps,
each with a worked example already in the tree.

1. **Add the service id** to `ServiceIdSchema` in `src/config/schema.ts`, and a
   schema for it in `ServicesSchema`. Reuse `KeyedServiceSchema` unless the
   service authenticates differently.
2. **Pick or write an auth strategy** in `src/core/auth.ts`. The five existing
   shapes cover most services; write a new one only if the service does
   something genuinely different, as Transmission's session handshake does.
3. **Add its endpoints** to `ENDPOINTS` in `scripts/capture-fixtures.ts` and run
   `npm run capture` against a live instance. Review the diff.
4. **Write the adapter** in `src/services/<id>.ts`, implementing `ServiceAdapter`
   plus whichever capability interfaces the service actually supports.
   `src/services/sonarr.ts` is the simplest example; `src/services/transmission.ts`
   is the most unusual.
5. **Declare its contract** in `test/contract.test.ts` — the response fields your
   adapter reads. Omit the `spec` when the service publishes no OpenAPI document.
6. **Register it** in `src/services/registry.ts`.

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

Three of the eight services publish no usable OpenAPI spec, so the adapter
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
- **A secret is never rendered back.** API keys, the Transmission password and
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
committed. A nightly workflow re-fetches them and opens a PR when upstream
changes, so **review `specs/` in that diff** — the generated files are output,
not source, and are not meant to be read by hand.

Radarr, Sonarr, Prowlarr, Jellyfin and Seerr are generated. Bazarr, SABnzbd and
Transmission publish no usable spec and are hand-written against recorded
fixtures.

Two things worth knowing before you touch this:

- **The generator runs through `npx` at a pinned version, not as a
  devDependency.** `openapi-typescript` requires `typescript@^5.x` and this
  project is pinned to TypeScript 6, so a local install cannot resolve. Running
  it in npx's isolated tree keeps the conflict out of ours, and the tool is not
  part of the shipped artefact — its reviewed output is.
- **The generated types are nullable where the spec says nullable.** If a mapper
  fails to typecheck against them, fix the mapper. Do not widen it with a cast:
  that failure is the codegen doing the job it was added for.

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
