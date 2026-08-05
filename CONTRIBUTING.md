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

**Match on stable identifiers, not on display strings.** Both scan-state
implementations learned this the hard way: Radarr runs three tasks whose names
contain "Refresh", only one of which is the library scan, and Jellyfin's task
names are localised — a Dutch server returns "Mediabibliotheek scannen".

Three of the eight services publish no usable OpenAPI spec, so the adapter
interface is defined by us and must stay hand-writable. Code generation is an
implementation detail inside an adapter, never the shape of the contract.

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
